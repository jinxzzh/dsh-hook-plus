/**
 * dsh-hook-plus event IO (F5).
 *
 * Payloads are flat snake_case JSON; hook scripts / http services answer
 * with FLAT fields (no wrapper object):
 *
 *   { decision, ok, continue, reason, updatedInput, updatedOutput,
 *     additionalContext, worktreePath, action, content, retry,
 *     clearContext, systemMessage, suppressOutput, stopReason }
 *
 * - decision: "allow" | "deny" | "ask" ("ask" has no DSH approval UI, so it
 *   blocks with a "[ask]" reason the model can act on).
 * - ok: false  == deny.  continue: false == deny-and-stop.
 * - exit 2 from a script == deny (stderr becomes the reason).
 * - exit 0 + valid flat JSON is honored even though outcome.ok is true —
 *   blocking must NEVER rely on outcome.ok alone.
 * - any other nonzero exit without JSON == error (logged, never blocks
 *   unless the event + hook.block semantics say fail-closed on timeout).
 */

export const BLOCKABLE = Object.freeze([
  'PreToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'ConfigChange',
  'Elicitation',
  'ElicitationResult',
])

// Which flat output fields each event honors. Everything else is ignored
// with a warn so misconfigurations surface instead of silently dying.
export const OUTPUT_FIELDS = Object.freeze({
  SessionStart: ['additionalContext'],
  SessionEnd: [],
  UserPromptSubmit: ['additionalContext', 'sessionTitle'],
  PreToolUse: ['updatedInput', 'additionalContext', 'decision', 'reason'],
  PostToolUse: ['updatedOutput', 'additionalContext', 'decision', 'reason'],
  PostToolUseFailure: ['additionalContext'],
  PermissionRequest: ['updatedInput', 'updatedPermissions', 'decision', 'reason'],
  PermissionDenied: ['retry'],
  Stop: ['clearContext', 'decision', 'reason'],
  StopFailure: [],
  SubagentStart: ['additionalContext'],
  SubagentStop: ['clearContext', 'decision', 'reason'],
  PreCompact: ['decision', 'reason'],
  PostCompact: [],
  Notification: ['additionalContext'],
  InstructionsLoaded: [],
  ConfigChange: ['decision', 'reason'],
  CwdChanged: ['additionalContext'],
  FileChanged: ['additionalContext'],
  WorktreeCreate: ['worktreePath'],
  WorktreeRemove: [],
  Elicitation: ['action', 'content', 'decision', 'reason'],
  ElicitationResult: ['action', 'content', 'decision', 'reason'],
})

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

export function sessionOf(exec) {
  return exec?.agent?.session ?? exec?.session
}

export function cwdOf(session) {
  return session?.header?.cwd ?? process.cwd()
}

/**
 * Build the snake_case payload for one event. exec/result/data cover the
 * DSH seams; unknown seams simply leave their fields absent.
 */
export function buildPayload({ event, hookId, session, exec, result, data, extra } = {}) {
  const payload = {
    session_id: session?.id ?? null,
    cwd: cwdOf(session),
    hook_event_name: event,
    hook_id: hookId ?? undefined,
  }
  if (exec?.name !== undefined) payload.tool_name = exec.name
  if (exec?.arguments !== undefined) payload.tool_input = exec.arguments
  if (exec?.tool_use_id !== undefined) payload.tool_use_id = exec.tool_use_id

  if (result !== undefined) {
    payload.tool_response = {
      isError: result?.isError === true,
      ...(result?.error !== undefined ? { error: result.error?.message ?? String(result.error) } : {}),
      ...(textOf(result?.content) === undefined ? {} : { content: textOf(result.content) }),
    }
    if (result?.isError === true) {
      payload.error = result?.error?.message ?? String(result?.error ?? 'tool failed')
      payload.error_type = 'execution_failed'
    }
  }
  if (data !== undefined && data !== null) {
    payload.data = data
    if (data.reason !== undefined) payload.reason = data.reason?.kind ?? data.reason
    const content = textOf(data.content) ?? textOf(data.message?.content)
    if (content !== undefined) {
      payload.content = content
      // UserPromptSubmit matches `prompt`, but hosts deliver the text as
      // content/message — mirror it so string matchers see a value.
      if (payload.prompt === undefined) payload.prompt = content
    }
    if (typeof data.title === 'string') payload.title = data.title
    for (const key of [
      'prompt', 'source', 'model', 'trigger', 'custom_instructions', 'compact_summary',
      'notification_type', 'message', 'title', 'details', 'file_path', 'memory_type',
      'load_reason', 'old_cwd', 'new_cwd', 'name', 'worktree_path', 'stop_hook_active',
      'last_assistant_message', 'agent_id', 'agent_type', 'agent_transcript_path',
      'error', 'error_type', 'error_details', 'mcp_server_name', 'requested_schema',
      'action', 'elicitation_id', 'mode', 'url',
    ]) {
      if (data[key] !== undefined) payload[key] = data[key]
    }
    if (typeof data.event === 'string') payload.event = data.event
  }
  if (extra !== undefined) Object.assign(payload, extra)
  return payload
}

function asFlatObject(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null
  return output
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed)
    return asFlatObject(parsed)
  } catch {
    // Scripts often print logs around the JSON; recover the last {...} block.
    const start = trimmed.lastIndexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return asFlatObject(JSON.parse(trimmed.slice(start, end + 1)))
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * Resolve one hook run into a verdict. Reads, in order:
 *  1. outcome.output object (call http JSON / ask-check {ok,reason})
 *  2. stdout JSON (run scripts, exit 0 or otherwise)
 *  3. exit code (2 == deny)
 * Returns { block, decision, reason, fields... , error }.
 */
export function resolveVerdict({ hook, event, outcome, logger } = {}) {
  const allowed = OUTPUT_FIELDS[event] ?? []
  const pick = (obj) => {
    const fields = {}
    for (const key of allowed) {
      if (obj[key] !== undefined) fields[key] = obj[key]
    }
    const ignored = Object.keys(obj).filter(
      (key) => !allowed.includes(key)
        && ['decision', 'ok', 'continue', 'reason', 'updatedInput', 'updatedOutput', 'additionalContext'].includes(key),
    )
    if (ignored.length > 0) {
      logger?.warn?.(`[dsh-hook-plus] ${hook.id} (${event}) ignores ${ignored.join(',')} (not supported here)`)
    }
    return fields
  }

  let doc = asFlatObject(outcome?.output) ?? null
  let fromStdout = false
  if (!doc && typeof outcome?.stdout === 'string') {
    doc = parseJsonObject(outcome.stdout)
    fromStdout = doc !== null
  }
  // exit-2 with no JSON: stderr (fallback stdout) is the reason.
  const exitDeny = outcome?.exitCode === 2 || outcome?.exitCode === '2'
  const stderrText = typeof outcome?.stderr === 'string' ? outcome.stderr.trim() : ''
  const stdoutText = typeof outcome?.stdout === 'string' ? outcome.stdout.trim() : ''

  const decisionRaw = typeof doc?.decision === 'string' ? doc.decision.trim().toLowerCase() : undefined
  const okFalse = doc?.ok === false
  const continueFalse = doc?.continue === false
  const explicitDeny = decisionRaw === 'deny' || decisionRaw === 'ask' || okFalse || continueFalse

  // Fail-closed on timeout: an interceptor that hangs must not silently
  // allow the gated action. The caller still ANDs this with hook.block.
  // (Timeouts never wake the model: wake requires exit 2 / ok:false / deny.)
  const timedOut = outcome?.timedOut === true
  const block = explicitDeny || timedOut || (!doc && exitDeny)
  let reason
  if (doc?.reason !== undefined && doc.reason !== null && String(doc.reason).trim() !== '') {
    reason = String(doc.reason)
  } else if (decisionRaw === 'ask') {
    reason = '[ask] hook requested approval; no approval UI is wired, treating as deny'
  } else if (block) {
    reason = stderrText || stdoutText || `hook "${hook.id}" blocked ${event} (exit ${outcome?.exitCode ?? '?'})`
    if (fromStdout && stdoutText !== '' && reason === stdoutText) reason = stdoutText.slice(0, 2000)
  }

  return {
    block,
    decision: decisionRaw ?? (okFalse || continueFalse ? 'deny' : undefined),
    reason: reason?.slice(0, 2000),
    fields: doc ? pick(doc) : {},
    error: !block && outcome?.ok === false && outcome?.error ? String(outcome.error).slice(0, 500) : undefined,
    timedOut: outcome?.timedOut === true,
  }
}

/** One-line-plus-reason block the model can actually read. */
export function formatRunSummary({ hook, payload, outcome, verdict }) {
  const status = verdict.block
    ? `blocked(${outcome?.timedOut ? 'timeout' : `exit ${outcome?.exitCode ?? 'deny'}`})`
    : (outcome?.ok === false ? `errored(exit ${outcome?.exitCode ?? '?'})` : 'ok')
  const lines = [
    `[Hook dsh-hook-plus] id=${hook.id} | on=${hook.on} | action=${hook.action}` +
    (payload?.tool_name ? ` | tool=${payload.tool_name}` : '') +
    ` | result=${status} | ${outcome?.durationMs ?? 0}ms`,
  ]
  if (verdict.reason) lines.push(`Reason: ${verdict.reason}`)
  if (verdict.fields?.updatedInput !== undefined) {
    lines.push(`UpdatedInput: ${JSON.stringify(verdict.fields.updatedInput).slice(0, 1000)}`)
  }
  if (verdict.fields?.updatedOutput !== undefined) {
    lines.push(`UpdatedOutput: ${JSON.stringify(verdict.fields.updatedOutput).slice(0, 1000)}`)
  }
  if (verdict.fields?.additionalContext !== undefined) {
    lines.push(`AdditionalContext: ${String(verdict.fields.additionalContext).slice(0, 1000)}`)
  }
  return lines.join('\n')
}
