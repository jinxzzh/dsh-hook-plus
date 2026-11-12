/**
 * dsh-hook-plus executors (F3): `run` (shell/exec) + `call` (http).
 * Zero dependencies: node:child_process + global fetch only.
 *
 * run:
 *   - no `args`  -> shell form: spawn(cmd, { shell: hook.shell ?? true })
 *   - with args  -> exec form: spawn(cmd, args, { shell: false })
 *   - timeout kills the process tree (taskkill on win32) and reports timedOut
 * call:
 *   - POST stdin payload as JSON, expect JSON HookOutput (flat fields).
 *   - headers support ${ENV} interpolation, gated by allowedEnvVars.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MAX_CAPTURE_BYTES = 32 * 1024

function cap(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) return text
  return Buffer.from(text, 'utf8')
    .subarray(0, MAX_CAPTURE_BYTES)
    .toString('utf8')
    .replace(/�$/u, '')
}

function terminate(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

export function hookEnv(hook, payload, cwd) {
  const env = { ...process.env, ...(hook.env ?? {}) }
  env.DSH_HOOK_ID = hook.id
  env.DSH_HOOK_EVENT = hook.on
  env.DSH_HOOK_CWD = cwd
  env.QODER_PROJECT_DIR = cwd
  env.CLAUDE_PROJECT_DIR = cwd
  if (payload.session_id !== null && payload.session_id !== undefined) {
    env.DSH_SESSION_ID = String(payload.session_id)
  }
  if (payload.tool_name !== undefined) env.DSH_TOOL_NAME = String(payload.tool_name)
  return env
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Expand a leading ~/ to the user home. Shells only do this for unquoted
 * words (and never on Windows cmd), so the plugin does it deterministically.
 */
export function expandTilde(text) {
  const str = String(text ?? '')
  if (str === '~') return homedir()
  if (str.startsWith('~/') || str.startsWith('~\\')) return join(homedir(), str.slice(2))
  return str
}

/**
 * Expand ${VAR} from the hook env. Used ONLY where no shell runs
 * (exec form, http headers): in shell form the shell itself must expand,
 * otherwise scripts using ${1} / ${VAR} at runtime would break.
 */
export function expandVars(text, env) {
  return String(text ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
    if (env?.[name] !== undefined) return env[name]
    if (process.env[name] !== undefined) return process.env[name]
    return ''
  })
}

function finishRun(startedAt, stdout, stderr, outcome, logger, hook) {
  const result = {
    ok: outcome.ok,
    exitCode: outcome.exitCode ?? null,
    timedOut: outcome.timedOut === true,
    durationMs: Date.now() - startedAt,
    stdout: cap(stdout),
    stderr: cap(stderr),
    signal: outcome.signal ?? null,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  }
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error
    if (detail !== undefined && detail !== '') {
      logger?.warn?.(`[dsh-hook-plus] ${hook.id} (${hook.on}) failed: ${String(detail).slice(0, 300)}`)
    }
  }
  return result
}

function runWithSpawn(doSpawn, hook, payload, { cwd, logger, background = false } = {}) {
  const workdir = cwd ?? process.cwd()
  const startedAt = Date.now()
  const input = hook.stdin !== false ? JSON.stringify(payload) : undefined
  const env = hookEnv(hook, payload, workdir)
  return new Promise((resolve) => {
    let child
    try {
      const execForm = Array.isArray(hook.args)
      child = execForm
        ? doSpawn(
            expandVars(expandTilde(hook.run), env),
            hook.args.map((item) => expandVars(item, env)),
            {
              shell: false,
              cwd: workdir,
              env,
              stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
              windowsHide: true,
            },
          )
        : doSpawn(expandTilde(hook.run), {
            // NOTE: shell form intentionally does NOT expand ${VAR} here —
            // the shell owns that (scripts may use ${1}/$(...) at runtime).
            shell: hook.shell ?? true,
            cwd: workdir,
            env,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
    } catch (error) {
      resolve(finishRun(startedAt, '', '', {
        ok: false, exitCode: null, error: error instanceof Error ? error.message : String(error),
      }, logger, hook))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer

    const finish = (outcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(finishRun(startedAt, stdout, stderr, { ...outcome, timedOut }, logger, hook))
    }

    child.once('error', (error) => finish({ ok: false, exitCode: null, error: error.message }))
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('close', (code, signal) => finish({ ok: code === 0, exitCode: code, signal }))

    timer = setTimeout(() => {
      timedOut = true
      terminate(child)
      finish({ ok: false, exitCode: null, error: 'timeout' })
    }, hook.timeoutMs)

    if (input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.write(input)
      child.stdin.end()
    }
    if (background) child.unref()
  })
}

/** Run a `run` hook command. Never rejects. */
export function runCommand(hook, payload, options = {}) {
  return runWithSpawn(spawn, hook, payload, options)
}

function interpolateHeaders(headers, allowedEnvVars) {
  const out = {}
  for (const [key, template] of Object.entries(headers ?? {})) {
    out[key] = String(template).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
      if (allowedEnvVars !== undefined && !allowedEnvVars.includes(name)) return full
      return process.env[name] ?? ''
    })
  }
  return out
}

/**
 * Run a `call` hook: POST payload JSON, expect JSON HookOutput.
 * Returns { ok, status, output, raw, durationMs, timedOut, error }.
 * `ok` = HTTP 2xx received (decision handling belongs to the caller/F6).
 */
export async function runHttp(hook, payload, { logger } = {}) {
  const startedAt = Date.now()
  const headers = {
    'content-type': 'application/json',
    ...interpolateHeaders(hook.headers, hook.allowedEnvVars),
  }
  try {
    const response = await fetch(hook.call, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(hook.timeoutMs),
    })
    const raw = await response.text()
    let output = null
    try {
      output = raw === '' ? null : JSON.parse(raw)
    } catch {
      output = null
    }
    const result = {
      ok: response.ok,
      status: response.status,
      output,
      raw: cap(raw),
      durationMs: Date.now() - startedAt,
      timedOut: false,
    }
    if (!result.ok || (raw.trim() !== '' && !isPlainObject(output))) {
      logger?.warn?.(`[dsh-hook-plus] ${hook.id} (${hook.on}) http ${response.status}: ${raw.slice(0, 300)}`)
    }
    return result
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.name === 'TimeoutError' || /aborted|timeout/i.test(error.message))
    return {
      ok: false,
      status: null,
      output: null,
      raw: '',
      durationMs: Date.now() - startedAt,
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Runner owning child processes so plugin teardown can terminate them.
 * Records every run for /hooks display.
 * ask/check hooks dispatch to the injected `evaluator` (see plus-eval.js);
 * without one they skip-allow loudly instead of stalling the pipeline.
 */
export function createRunner({ logger, record, evaluator } = {}) {
  const children = new Set()
  let disposed = false
  const trackedSpawn = (...args) => {
    const child = spawn(...args)
    children.add(child)
    child.once('close', () => children.delete(child))
    return child
  }

  return {
    async run(hook, payload, { cwd, background = false } = {}) {
      if (disposed) {
        return { ok: false, exitCode: null, timedOut: false, durationMs: 0, error: 'disposed', stdout: '', stderr: '' }
      }
      let outcome
      if (hook.action === 'ask' || hook.action === 'check') {
        const { runEval } = await import('./plus-eval.js')
        const evalResult = await runEval(hook.action, hook, payload, { cwd, logger, evaluator })
        outcome = {
          ok: evalResult.ok,
          exitCode: evalResult.ok ? 0 : 2,
          timedOut: evalResult.timedOut === true,
          durationMs: evalResult.durationMs,
          stdout: '',
          stderr: evalResult.reason ?? '',
          output: { ok: evalResult.ok, ...(evalResult.reason ? { reason: evalResult.reason } : {}) },
          ...(evalResult.skipped === true ? { skipped: true } : {}),
          ...(evalResult.error === undefined ? {} : { error: evalResult.error }),
        }
        if (evalResult.skipped === true) {
          logger?.warn?.(`[dsh-hook-plus] ${hook.id} (${hook.on}) ${hook.action} skipped: no evaluator wired (allow)`)
        }
      } else if (hook.action === 'call') {
        const http = await runHttp(hook, payload, { logger })
        outcome = {
          ok: http.ok,
          exitCode: http.ok ? 0 : 1,
          timedOut: http.timedOut,
          durationMs: http.durationMs,
          stdout: typeof http.raw === 'string' ? http.raw : '',
          stderr: '',
          output: http.output,
          status: http.status,
          ...(http.error === undefined ? {} : { error: http.error }),
        }
      } else {
        outcome = await runWithSpawn(trackedSpawn, hook, payload, { cwd, logger, background })
      }
      record?.({ hookId: hook.id, event: hook.on, action: hook.action, tool: payload.tool_name, at: Date.now(), ...outcome })
      return outcome
    },
    dispose() {
      disposed = true
      for (const child of children) terminate(child)
      children.clear()
    },
  }
}
