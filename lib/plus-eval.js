/**
 * dsh-hook-plus evaluators (F4): `ask` (single model call) + `check` (sub-agent).
 *
 * The plugin is zero-dependency and cannot assume which model service the
 * DSH host exposes, so execution goes through an injected `evaluator`:
 *
 *   evaluator({ kind, hook, payload, prompt, model, tools, maxTurns,
 *               timeoutMs, cwd, signal }) -> { ok, reason?, error? }
 *
 * - kind: "ask" | "check"
 * - prompt: ask -> hook.ask + "\n\n<Event JSON>"; check -> hook.check with
 *   $ARGUMENTS replaced by the event JSON.
 * - returns ok=true (allow) / ok=false (block), reason shown to Agent/model.
 * - signal: AbortSignal aborting at hook.timeoutMs (evaluator SHOULD honor it;
 *   runEval also races a timer as a backstop).
 *
 * Default evaluator: explicit skip-allow (never fail-closed on missing
 * wiring) with a warn log, so unwired ask/check hooks cannot stall a pipeline.
 */

export function defaultEvaluator({ kind, hook }) {
  return {
    ok: true,
    skipped: true,
    reason: `${kind} evaluator not wired; hook "${hook.id}" skipped (allow)`,
  }
}

/**
 * Zero-dependency OpenAI-compatible evaluator for ask/check.
 * Expects the model to answer with strict JSON: {"ok": bool, "reason": str}.
 * Config: config.llm = { baseUrl, apiKey, model } or env
 * DSH_HOOK_LLM_URL / DSH_HOOK_LLM_KEY / DSH_HOOK_LLM_MODEL.
 */
export function createOpenAiEvaluator({ baseUrl, apiKey, model, logger } = {}) {
  const url = String(baseUrl ?? '').replace(/\/+$/, '')
  if (url === '' || model === undefined || String(model).trim() === '') {
    throw new Error('OpenAI evaluator needs baseUrl and model')
  }
  return async ({ kind, prompt, timeoutMs, signal }) => {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: String(model).trim(),
        messages: [
          {
            role: 'system',
            content: 'You are a hook judge. Answer with strict JSON only: {"ok": boolean, "reason": string}. ok=false blocks the action.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 256,
      }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    if (!response.ok) {
      return { ok: false, error: `llm http ${response.status}: ${raw.slice(0, 300)}` }
    }
    let content = ''
    try {
      const body = JSON.parse(raw)
      content = body?.choices?.[0]?.message?.content ?? ''
    } catch {
      return { ok: false, error: `llm returned non-JSON envelope: ${raw.slice(0, 300)}` }
    }
    const start = String(content).lastIndexOf('{')
    const end = String(content).lastIndexOf('}')
    if (start === -1 || end <= start) {
      return { ok: false, error: `llm returned no JSON object: ${String(content).slice(0, 300)}` }
    }
    try {
      const parsed = JSON.parse(String(content).slice(start, end + 1))
      return {
        ok: parsed.ok !== false,
        ...(typeof parsed.reason === 'string' && parsed.reason.trim() !== '' ? { reason: parsed.reason.slice(0, 2000) } : {}),
      }
    } catch {
      return { ok: false, error: `llm returned unparsable JSON: ${String(content).slice(0, 300)}` }
    }
  }
}

/**
 * Resolve the evaluator for ask/check hooks:
 *   1. config.evaluator function (explicit injection wins);
 *   2. config.llm { baseUrl, apiKey?, model } or DSH_HOOK_LLM_* env;
 *   3. undefined -> runner falls back to skip-allow default.
 *
 * NOTE: the host ctx is deliberately NOT probed for model services — model
 * calls cost tokens and can have side effects, so blind auto-dialing an
 * unknown ctx API is worse than a loud skip. Wire explicitly.
 */
export function resolveEvaluator({ config = {}, logger } = {}) {
  if (typeof config.evaluator === 'function') return config.evaluator
  const llm = config.llm ?? {}
  const baseUrl = llm.baseUrl ?? process.env.DSH_HOOK_LLM_URL
  const apiKey = llm.apiKey ?? process.env.DSH_HOOK_LLM_KEY
  const model = llm.model ?? process.env.DSH_HOOK_LLM_MODEL
  if (baseUrl && model) {
    try {
      return createOpenAiEvaluator({ baseUrl, apiKey, model, logger })
    } catch (error) {
      logger?.warn?.(`[dsh-hook-plus] invalid llm config, ask/check will skip: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  return undefined
}

function normalizeEvalResult(raw, kind, hookId) {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: `evaluator for hook "${hookId}" returned non-object (${kind})` }
  }
  if (typeof raw.ok !== 'boolean') {
    return { ok: false, error: `evaluator for hook "${hookId}" must return boolean ok (${kind})` }
  }
  const out = { ok: raw.ok }
  if (raw.reason !== undefined && raw.reason !== null) out.reason = String(raw.reason).slice(0, 2000)
  if (raw.skipped === true) out.skipped = true
  if (raw.error !== undefined && raw.error !== null) out.error = String(raw.error).slice(0, 500)
  return out
}

export function buildEvalPrompt(hook, payload) {
  const eventJson = JSON.stringify(payload)
  if (hook.action === 'check') {
    // Forgiving: a missing $ARGUMENTS placeholder must not starve the
    // sub-agent of event data — append exactly like ask does.
    if (!String(hook.check).includes('$ARGUMENTS')) return `${hook.check}\n\n${eventJson}`
    return String(hook.check).split('$ARGUMENTS').join(eventJson)
  }
  return `${hook.ask}\n\n${eventJson}`
}

/**
 * Run one ask/check hook. Never rejects. Fail-closed on timeout/error ONLY
 * in the sense that ok=false is reported — the caller (F6) decides whether
 * that blocks, based on hook.block + hook.async + event semantics.
 */
export async function runEval(kind, hook, payload, { cwd, logger, evaluator } = {}) {
  const startedAt = Date.now()
  const evaluate = evaluator ?? defaultEvaluator
  const prompt = buildEvalPrompt(hook, payload)
  const params = {
    kind,
    hook,
    payload,
    prompt,
    model: hook.model,
    tools: hook.tools,
    maxTurns: hook.maxTurns,
    timeoutMs: hook.timeoutMs,
    cwd: cwd ?? process.cwd(),
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), hook.timeoutMs)
    let result
    try {
      result = await Promise.race([
        evaluate({ ...params, signal: controller.signal }),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    const normalized = normalizeEvalResult(result, kind, hook.id)
    return {
      ...normalized,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.message)
    return {
      // Fail-closed: an evaluator crash/timeout in a blocking position denies.
      // Background positions ignore ok=false (caller/F6 decides by hook.async).
      ok: false,
      timedOut,
      ...(timedOut ? { error: 'timeout' } : { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }),
      durationMs: Date.now() - startedAt,
    }
  }
}
