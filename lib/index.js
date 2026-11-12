/**
 * dsh-hook-plus — Qoder-compatible lifecycle hooks for DeepSeek Harness.
 *
 * New self-owned format (no Qoder/lite compat):
 *   - id / on (22 canonical events) / match (string shorthand | object)
 *   - run | call | ask | check (exactly one; action inferred, no `type:`)
 *   - timeout ("30s", bare numbers are seconds), async (sync/background/rewake)
 *
 * DSH seams wired:
 *   tools/pre-execute   -> PreToolUse            (blocking waterfall, awaited)
 *   tools/post-execute  -> PostToolUse / PostToolUseFailure (sync awaited or background)
 *   session/event       -> Stop (turn/end), UserPromptSubmit (user/message, observe-only:
 *                          DSH broadcast cannot block, deny becomes a wake-up note)
 *   step/end, session/title have no Qoder counterpart yet -> skipped with a warn.
 *
 * Model visibility: denials, rewrites, injected context and rewake notes all
 * carry a structured [Hook dsh-hook-plus] summary so the MODEL sees what ran.
 */
import {
  BLOCKABLE,
  buildPayload,
  cwdOf,
  formatRunSummary,
  resolveVerdict,
  sessionOf,
} from './plus-events.js'
import { loadAll } from './plus-load.js'
import { matchHook } from './plus-match.js'
import { createRunner } from './plus-exec.js'
import { PLUS_EVENTS } from './plus-format.js'
import { resolveEvaluator } from './plus-eval.js'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-hook-plus'

const RECENT_RUNS_LIMIT = 20

// DSH legacy session/event types mapped onto canonical events.
// Canonical names pass through untouched (see handler below).
const SESSION_EVENT_MAP = Object.freeze({
  'turn/end': 'Stop',
  'user/message': 'UserPromptSubmit',
})

function pushRecentRun(runs, record) {
  runs.unshift(record)
  if (runs.length > RECENT_RUNS_LIMIT) runs.length = RECENT_RUNS_LIMIT
}

function resolveHookCwd(hook, sessionCwd) {
  if (hook.cwd === undefined || hook.cwd === '') return undefined
  if (hook.cwd === 'session') return sessionCwd
  return hook.cwd
}

/** exec.agent -> agent, for followup-based wakeups. */
function agentOf(exec) {
  const agent = exec?.agent
  return agent !== null && typeof agent === 'object' ? agent : undefined
}

/** In-house wake path (same as session-controller/subagents):
 *  agent.followup(createUserMessage(...)) -> next-turn + wakeDriver. */
/** Agent seen on this session object before (pre/post carry exec.agent). */
function cachedAgent(map, session) {
  if (session === null || (typeof session !== 'object' && typeof session !== 'function')) return undefined
  try { return map.get(session) } catch { return undefined }
}

function wakeViaAgent(agent, text, logger, hookId) {
  if (typeof agent?.followup !== 'function') return false
  try {
    agent.followup(Object.freeze({
      content: [{ type: 'text', text: String(text) }],
      // kind:'user' is the only inbox path the loop is proven to render;
      // hook identity travels in the text prefix ([Hook dsh-hook-plus ...]).
      source: { kind: 'user' },
      role: 'user',
      id: randomUUID(),
    }))
    return true
  } catch (error) {
    logger?.warn?.('[dsh-hook-plus] ' + hookId + ': agent.followup failed: ' + (error instanceof Error ? error.message : String(error)))
    return false
  }
}

/** Best-effort wake-up: ask the session to continue with a note. */
function wakeSession(session, agent, text, logger, hookId) {
  if (agent && wakeViaAgent(agent, text, logger, hookId)) return true
  if (session === null || typeof session !== 'object') {
    logger?.warn?.('[dsh-hook-plus] ' + hookId + ': rewake requested but no session object')
    return false
  }
  for (const method of ['injectMessage', 'appendMessage', 'sendMessage', 'notify', 'injectContext']) {
    try {
      if (typeof session[method] === 'function') {
        session[method](text)
        return true
      }
    } catch (error) {
      logger?.warn?.('[dsh-hook-plus] ' + hookId + ': rewake via ' + method + ' failed: ' + (error instanceof Error ? error.message : String(error)))
      return false
    }
  }
  logger?.warn?.('[dsh-hook-plus] ' + hookId + ': rewake requested but no wake path worked; note logged only:\n' + text)
  return false
}

function rewakeText(hook, payload, outcome, verdict) {
  const body = hook.rewakeMessage ?? formatRunSummary({ hook, payload, outcome, verdict })
  return hook.rewakeSummary ? `${hook.rewakeSummary}\n${body}` : body
}

/**
 * Wire hooks into one DSH context.
 * @param ctx - cordis host context.
 * @param config - `{ hooks?: PlusHook[], evaluator?: Function }`.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  let loaded = loadAll({ config, cwd: process.cwd() })
  let hooks = loaded.hooks
  // Mutable runtime settings (file-level "debug" objects + future knobs);
  // refreshed by /hooks-reload so no restart is needed to toggle them.
  const runtime = { settings: { ...(loaded.settings ?? {}) } }
  const warnings = [...loaded.errors]
  const recentRuns = []
  const consumedOnce = new Set()
  const warnedUnknownEvent = new Set()
  // Notes produced by pre-execute hooks (rewrites, injected context) that the
  // model would otherwise never see: flushed into result.content at post.
  const pendingNotes = new WeakMap()
  // exec.agent seen per session (session/event handlers have no exec).
  const agentBySession = new WeakMap()
  const runner = createRunner({
    logger,
    evaluator: config.evaluator ?? resolveEvaluator({ config, logger }),
    record: (record) => pushRecentRun(recentRuns, record),
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => runner.dispose(), 'dsh-hook-plus: runner')
  }

  let warningsLogged = false
  const warnOnce = () => {
    if (warningsLogged) return
    warningsLogged = true
    for (const warning of warnings) logger?.warn?.(`[dsh-hook-plus] ${warning}`)
  }
  warnOnce()

  const activeHooks = (event) => hooks.filter(
    (hook) => hook.enabled && hook.on === event && !consumedOnce.has(hook.id),
  )
  const markOnce = (hook, outcome) => {
    // "Successful execution" consumes: evaluated fine (deny counts),
    // errors/timeouts do not.
    if (hook.once === true && !outcome.error && !outcome.timedOut) consumedOnce.add(hook.id)
  }

  const effect = (register, label) => {
    if (typeof ctx.effect === 'function') ctx.effect(register, label)
    else register()
  }


  const stashNote = (exec, line) => {
    if (exec === null || (typeof exec !== 'object' && typeof exec !== 'function')) return
    try {
      const list = pendingNotes.get(exec) ?? []
      list.push(line)
      pendingNotes.set(exec, list)
    } catch {
      // primitives / sealed hosts: note dropped, never crash the pipeline
    }
  }

  const flushNotes = (exec, result, logger) => {
    let notes = []
    try {
      notes = pendingNotes.get(exec) ?? []
      pendingNotes.delete(exec)
    } catch {
      notes = []
    }
    if (notes.length === 0) return
    try {
      if (!Array.isArray(result.content)) result.content = []
      for (const line of notes) result.content.push({ type: 'text', text: line })
    } catch (error) {
      logger?.warn?.(`[dsh-hook-plus] could not attach hook notes: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const runSyncHook = async (hook, payload, session) => {
    const outcome = await runner.run(hook, payload, { cwd: resolveHookCwd(hook, cwdOf(session)) })
    markOnce(hook, outcome)
    const verdict = resolveVerdict({ hook, event: hook.on, outcome, logger })
    return { outcome, verdict }
  }

  const runBackgroundHook = (hook, payload, session, { wake = false } = {}) => {
    void runner.run(hook, payload, { cwd: resolveHookCwd(hook, cwdOf(session)), background: true })
      .then((outcome) => {
        markOnce(hook, outcome)
        const verdict = resolveVerdict({ hook, event: hook.on, outcome, logger })
        // rewake ONLY on explicit deny (exit 2 / decision deny / ok:false):
        // plain script errors (exit 1) and timeouts never wake the model.
        if (wake && hook.async === 'rewake' && verdict.block
          && (outcome.exitCode === 2 || outcome.output?.ok === false || verdict.decision === 'deny')) {
          wakeSession(session, cachedAgent(agentBySession, session), rewakeText(hook, payload, outcome, verdict), logger, hook.id)
        }
      })
  }

  // ---- tools/pre-execute -> PreToolUse (blocking waterfall) ----
  effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const session = sessionOf(exec)
    const seenAgent = agentOf(exec)
    if (seenAgent && session) { try { agentBySession.set(session, seenAgent) } catch {} }
    for (const hook of activeHooks('PreToolUse')) {
      const payload = buildPayload({ event: 'PreToolUse', hookId: hook.id, session, exec })
      if (!matchHook(hook, payload, exec?.name)) continue
      if (hook.async !== 'sync') {
        runBackgroundHook(hook, payload, session, { wake: true })
        continue
      }
      const { outcome, verdict } = await runSyncHook(hook, payload, session)
      if (verdict.fields.updatedInput !== undefined && verdict.fields.updatedInput !== null
        && typeof verdict.fields.updatedInput === 'object' && !Array.isArray(verdict.fields.updatedInput)) {
        exec.arguments = verdict.fields.updatedInput
        stashNote(exec, `[Hook ${hook.id}] updated tool input: ${JSON.stringify(verdict.fields.updatedInput).slice(0, 500)}`)
      }
      if (verdict.fields.additionalContext !== undefined) {
        stashNote(exec, `[Hook ${hook.id}] ${String(verdict.fields.additionalContext).slice(0, 1000)}`)
      }
      if (verdict.block && hook.block) {
        return { kind: 'deny', reason: formatRunSummary({ hook, payload, outcome, verdict }) }
      }
    }
    return next()
  }), 'dsh-hook-plus: pre-tool')

  // ---- tools/post-execute -> PostToolUse / PostToolUseFailure ----
  effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
    const session = sessionOf(exec)
    const seenAgent = agentOf(exec)
    if (seenAgent && session) { try { agentBySession.set(session, seenAgent) } catch {} }
    const failed = result?.isError === true
    const event = failed ? 'PostToolUseFailure' : 'PostToolUse'
    for (const hook of activeHooks(event)) {
      const payload = buildPayload({ event, hookId: hook.id, session, exec, result })
      if (!matchHook(hook, payload, exec?.name)) continue
      if (hook.async !== 'sync') {
        runBackgroundHook(hook, payload, session, { wake: true })
        continue
      }
      const { outcome, verdict } = await runSyncHook(hook, payload, session)
      try {
        if (verdict.fields.updatedOutput !== undefined && !failed) {
          if (typeof verdict.fields.updatedOutput === 'string') {
            if (!Array.isArray(result.content)) result.content = []
            result.content = [{ type: 'text', text: verdict.fields.updatedOutput }]
          } else {
            result.hookOutput = verdict.fields.updatedOutput
          }
          stashNote(exec, `[Hook ${hook.id}] updated tool output`)
        }
        if (verdict.fields.additionalContext !== undefined) {
          stashNote(exec, `[Hook ${hook.id}] ${String(verdict.fields.additionalContext).slice(0, 1000)}`)
        }
        flushNotes(exec, result, logger)
      } catch (error) {
        logger?.warn?.(`[dsh-hook-plus] ${hook.id}: could not apply post-tool output: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (verdict.block) {
        logger?.warn?.(`[dsh-hook-plus] ${hook.id} (${event}) returned deny outside a blocking seam; logged only:\n${formatRunSummary({ hook, payload, outcome, verdict })}`)
      }
    }
    // Flush pre-execute notes even when no post hook matched: otherwise a
    // rewrite would stay invisible whenever PostToolUse has zero hooks.
    if (result !== null && typeof result === 'object') {
      flushNotes(exec, result, logger)
    }
    return next()
  }), 'dsh-hook-plus: post-tool')

  // ---- session/event: mapped legacy names + canonical passthrough ----
  effect(() => ctx.on('session/event', (session, event) => {
    const type = event?.type
    // Legacy DSH names first, then any canonical event the host emits
    // directly (SessionStart, Notification, ...). Unknown types warn once.
    const mapped = SESSION_EVENT_MAP[type] ?? (PLUS_EVENTS.includes(type) ? type : undefined)
    if (!mapped) {
      if (!warnedUnknownEvent.has(type)) {
        warnedUnknownEvent.add(type)
        logger?.warn?.(`[dsh-hook-plus] unknown session event "${type}"; hooks on it are skipped`)
      }
      return
    }
    const active = activeHooks(mapped)
    if (active.length === 0) return
    const data = event?.data ?? {}
    for (const hook of active) {
      const payload = buildPayload({ event: mapped, hookId: hook.id, session, data })
      if (!matchHook(hook, payload, undefined)) continue
      if (hook.async !== 'sync') {
        runBackgroundHook(hook, payload, session, { wake: true })
        continue
      }
      // Broadcast seam: cannot return-block. Sync deny becomes a wake-up note
      // so the model still sees it next turn.
      void runner.run(hook, payload, { cwd: resolveHookCwd(hook, cwdOf(session)) })
        .then((outcome) => {
          markOnce(hook, outcome)
          const verdict = resolveVerdict({ hook, event: mapped, outcome, logger })
          if (verdict.block && hook.block) {
            wakeSession(session, cachedAgent(agentBySession, session), formatRunSummary({ hook, payload, outcome, verdict }), logger, hook.id)
          } else if (verdict.fields.additionalContext !== undefined) {
            wakeSession(session, cachedAgent(agentBySession, session), `[Hook ${hook.id}] ${String(verdict.fields.additionalContext)}`, logger, hook.id)
          }
        })
    }
  }), 'dsh-hook-plus: session events')

  const renderHookList = () => {
    if (hooks.length === 0) return 'No hooks configured. Add them to $DSH_HOME/hooks.json, .dsh/hooks.json, or inline config.hooks.'
    return hooks.map((hook) => {
      const flags = [
        hook.enabled ? '●' : '○',
        hook.async !== 'sync' ? hook.async : null,
        hook.once ? 'once' : null,
        consumedOnce.has(hook.id) ? 'consumed' : null,
      ].filter(Boolean).join(',')
      const match = hook.match === undefined ? 'always'
        : (typeof hook.match === 'string' ? hook.match : Object.keys(hook.match).join(','))
      return `- ${flags} ${hook.id} [${hook.on}] ${hook.action}:${typeof hook[hook.action] === 'string' ? hook[hook.action].slice(0, 80) : ''} match=${match} timeout=${hook.timeoutMs}ms`
    }).join('\n')
  }

  const renderRecentRuns = () => {
    if (recentRuns.length === 0) return 'No runs yet.'
    return recentRuns.map((run) => {
      const status = run.ok ? 'ok' : `fail(exit ${run.exitCode ?? '?'}${run.timedOut ? ' timeout' : ''})`
      const where = run.tool ? `${run.event}/${run.tool}` : run.event
      const reason = run.stderr?.trim() || run.error || ''
      return `- ${new Date(run.at).toISOString()} ${run.hookId} (${where}) ${status} ${run.durationMs}ms${reason ? ` :: ${reason.slice(0, 160)}` : ''}`
    }).join('\n')
  }


  // Debug probe: when runtime.settings.dumpSessionKeys is set (via a hooks
  // file top-level "debug" object + /hooks-reload), snapshot the live session
  // API surface to that file on every tool call. Temporary diagnostic; remove
  // the flag when done. Never throws into the tool pipeline.
  effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const dumpFile = runtime.settings.dumpSessionKeys
    if (dumpFile) {
      try {
        const session = sessionOf(exec)
        const surface = {}
        let obj = session
        for (let depth = 0; obj !== null && obj !== undefined && obj !== Object.prototype && depth < 4; depth += 1) {
          surface[`depth${depth}:${obj.constructor?.name ?? typeof obj}`] = Object.getOwnPropertyNames(obj)
          obj = Object.getPrototypeOf(obj)
        }
        appendFileSync(String(dumpFile), JSON.stringify({
          at: new Date().toISOString(),
          tool: exec?.name,
          surface,
        }).slice(0, 6000) + '\n')
      } catch (error) {
        logger?.warn?.(`[dsh-hook-plus] session dump failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next()
  }), 'dsh-hook-plus: debug session probe')
  const registerCommands = (commands) => {
    if (typeof commands?.register !== 'function') return
    effect(() => commands.register({
      name: 'hooks',
      description: 'List dsh-hook-plus hooks, sources, warnings, and recent runs',
      handler: () => ({
        kind: 'success',
        text: [
          '# dsh-hook-plus',
          `sources: user=${loaded.files.user}`,
          `        proj=${loaded.files.proj}`,
          `        local=${loaded.files.local} (+ inline config.hooks)`,
          loaded.overrides.length > 0 ? `overrides:\n${loaded.overrides.map((line) => `  ! ${line}`).join('\n')}` : null,
          '',
          renderHookList(),
          ...(warnings.length > 0 ? ['', 'Warnings:', ...warnings.map((line) => `! ${line}`)] : []),
          ...(loaded.overrides.length > 0 && warnings.length === 0 ? [] : []),
          '',
          '# Recent runs',
          '',
          renderRecentRuns(),
        ].filter((line) => line !== null).join('\n'),
      }),
    }), 'dsh-hook-plus: /hooks')

    effect(() => commands.register({
      name: 'hooks-reload',
      description: 'Re-read all hook config sources and replace the active hook list',
      handler: () => {
        loaded = loadAll({ config, cwd: process.cwd() })
        hooks = loaded.hooks
        runtime.settings = { ...(loaded.settings ?? {}) }
        consumedOnce.clear()
        warnings.push(...loaded.errors)
        warningsLogged = false
        warnOnce()
        return {
          kind: 'success',
          text: `reloaded ${hooks.length} hooks (overrides: ${loaded.overrides.length})\n\n${renderHookList()}`,
        }
      },
    }), 'dsh-hook-plus: /hooks-reload')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scope) => registerCommands(scope.commands))
  } else {
    registerCommands(ctx.get?.('commands'))
  }

  if (typeof ctx.logger?.info === 'function' && hooks.length > 0) {
    ctx.logger.info(`[dsh-hook-plus] loaded ${hooks.length} hooks`)
  }

  // Visible for tests: BLOCKABLE is enforced per seam above.
  void BLOCKABLE
}

export { BLOCKABLE }
