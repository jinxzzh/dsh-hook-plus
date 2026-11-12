/**
 * dsh-hook-plus — new config format (not Qoder-shape, not lite-shape).
 *
 * Design goals from the user:
 *  - precise: one hook = one event + one action, matcher per-event typed.
 *  - extensible: new actions / modifiers grow as optional fields, never
 *    reshaping the common case.
 *  - token-cheap input: common hook is 3-4 fields; action is inferred from
 *    which key exists (run/call/ask/check), no `type:` tax.
 *  - detailed output: payload + run record stay verbose so the model can
 *    see exactly what happened.
 *
 * Common (3 fields):
 *   - id: guard-rm
 *     on: PreToolUse
 *     match: Bash(git *)
 *     run: ~/.qoder/hooks/block-rm.sh
 *
 * Full:
 *   - id: lint
 *     on: PostToolUse
 *     match: { tool: Write|Edit, arg: "*.ts" }   # tool = matcher syntax, arg = glob
 *     run: npx eslint --fix
 *     timeout: 30s
 *     async: background
 */

// Canonical Qoder event names (the contract we implement against).
export const PLUS_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
])

// Lite short names accepted as aliases (never emitted, only parsed).
// NOTE: 'step/end' and 'session/title' are deliberately NOT aliased — they
// have no Qoder counterpart and silently mapping them to Stop/SessionStart
// was misleading. Write Stop (or another canonical event) directly.
export const EVENT_ALIASES = Object.freeze({
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  'turn/end': 'Stop',
  'user/message': 'UserPromptSubmit',
})

export const ACTIONS = Object.freeze(['run', 'call', 'ask', 'check'])
export const ASYNC_MODES = Object.freeze(['sync', 'background', 'rewake'])

// Per-action default timeouts. Blocking pre-tool hooks stay short so a hung
// script cannot stall the agent; ask/check need model time.
export const DEFAULT_TIMEOUT_MS = Object.freeze({
  run: 30_000,
  call: 15_000,
  ask: 60_000,
  check: 120_000,
})
export const MAX_TIMEOUT_MS = 10 * 60_000

const NUMBER_COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq'])
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Bare numbers mean SECONDS (Qoder mental model): timeout: 30 -> 30s.
// Explicit units also accepted: "500ms", "30s", "5m".
export function parseTimeout(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.min(Math.trunc(value * 1000), MAX_TIMEOUT_MS)
  }
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(text)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  // No unit on a string is also seconds ("30" -> 30s), never milliseconds.
  const unit = match[2] ?? 's'
  const ms = unit === 'ms' ? amount : unit === 's' ? amount * 1000 : amount * 60_000
  return Math.min(Math.trunc(ms), MAX_TIMEOUT_MS)
}

export function normalizeEvent(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (PLUS_EVENTS.includes(text)) return text
  const lower = text.toLowerCase()
  for (const [alias, canonical] of Object.entries(EVENT_ALIASES)) {
    if (lower === alias.toLowerCase()) return canonical
  }
  // Case-insensitive fallback for canonical names.
  const hit = PLUS_EVENTS.find((name) => name.toLowerCase() === lower)
  return hit ?? null
}

function normalizeAsync(raw) {
  if (raw === undefined || raw === null || raw === false || raw === 'sync') return 'sync'
  if (raw === true || raw === 'background') return 'background'
  if (raw === 'rewake') return 'rewake'
  return null
}

/**
 * Normalize one hook entry in the plus format.
 * Exactly one action key must exist: run (shell), call (http url),
 * ask (prompt text), check (agent prompt).
 */
export function normalizeHook(entry, index = 0) {
  if (!isPlainObject(entry)) return { ok: false, error: 'hook entry must be an object' }
  const id = typeof entry.id === 'string' && entry.id.trim() !== ''
    ? entry.id.trim()
    : typeof entry.name === 'string' && entry.name.trim() !== ''
      ? entry.name.trim()
      : `hook-${index + 1}`
  const on = normalizeEvent(entry.on ?? entry.event)
  if (!on) return { ok: false, error: `hook "${id}": on must be one of ${PLUS_EVENTS.join(', ')}` }

  const present = ACTIONS.filter((key) => entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== '')
  if (present.length === 0) {
    return { ok: false, error: `hook "${id}": one action required (run/call/ask/check)` }
  }
  if (present.length > 1) {
    return { ok: false, error: `hook "${id}": only one action allowed, got ${present.join('+')}` }
  }
  const action = present[0]
  const actionText = String(entry[action]).trim()

  if (action === 'call') {
    try {
      const url = new URL(actionText)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      return { ok: false, error: `hook "${id}": call must be an http(s) URL` }
    }
  }

  if (entry.match !== undefined && entry.match !== null) {
    const match = entry.match
    const okMatch = typeof match === 'string'
      || (isPlainObject(match) && Object.keys(match).length > 0)
    if (!okMatch) return { ok: false, error: `hook "${id}": match must be a string or non-empty object` }
    if (isPlainObject(match)) {
      for (const [key, value] of Object.entries(match)) {
        if (typeof key !== 'string' || key.trim() === '') {
          return { ok: false, error: `hook "${id}": match keys must be non-empty strings` }
        }
        // Value semantics (matching engine in F2):
        // - string  -> regex, EXCEPT key "arg" which is a glob
        // - number/boolean -> exact equality
        // - {gt,gte,lt,lte,eq} -> numeric comparison
        const okValue = typeof value === 'string'
          || typeof value === 'number'
          || typeof value === 'boolean'
          || (isPlainObject(value) && Object.keys(value).length > 0
            && Object.keys(value).every((op) => NUMBER_COMPARATORS.has(op)))
        if (!okValue) {
          return { ok: false, error: `hook "${id}": match.${key} must be a regex/glob string, boolean/number, or numeric comparator` }
        }
      }
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS[action]
  if (entry.timeout !== undefined || entry.timeoutMs !== undefined) {
    const raw = entry.timeout ?? entry.timeoutMs
    // timeoutMs (legacy numeric) stays milliseconds; timeout uses parseTimeout.
    const parsed = entry.timeout !== undefined
      ? parseTimeout(raw)
      : (typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.min(Math.trunc(raw), MAX_TIMEOUT_MS)
        : null)
    if (parsed === null) return { ok: false, error: `hook "${id}": timeout must be like 500ms, 30s, 5m` }
    timeoutMs = parsed
  }

  const asyncMode = normalizeAsync(entry.async)
  if (asyncMode === null) {
    return { ok: false, error: `hook "${id}": async must be sync/background/rewake` }
  }

  if (entry.env !== undefined && entry.env !== null) {
    if (!isPlainObject(entry.env)) return { ok: false, error: `hook "${id}": env must be an object` }
    for (const [key, value] of Object.entries(entry.env)) {
      if (!ENV_KEY.test(key) || typeof value !== 'string') {
        return { ok: false, error: `hook "${id}": env keys must match [A-Za-z_][A-Za-z0-9_]* with string values` }
      }
    }
  }
  if (entry.cwd !== undefined && entry.cwd !== null && typeof entry.cwd !== 'string') {
    return { ok: false, error: `hook "${id}": cwd must be "session" or a directory path` }
  }
  if (entry.args !== undefined && entry.args !== null) {
    if (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `hook "${id}": args must be an array of strings (exec form)` }
    }
  }
  if (entry.headers !== undefined && entry.headers !== null) {
    if (!isPlainObject(entry.headers)) return { ok: false, error: `hook "${id}": headers must be an object` }
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof key !== 'string' || key.trim() === '' || typeof value !== 'string') {
        return { ok: false, error: `hook "${id}": headers must be string keys with string values` }
      }
    }
  }
  if (entry.allowedEnvVars !== undefined && entry.allowedEnvVars !== null) {
    if (!Array.isArray(entry.allowedEnvVars)
      || entry.allowedEnvVars.some((item) => typeof item !== 'string' || !ENV_KEY.test(item))) {
      return { ok: false, error: `hook "${id}": allowedEnvVars must be an array of env names` }
    }
  }
  if (entry.tools !== undefined && entry.tools !== null) {
    if (!Array.isArray(entry.tools)
      || entry.tools.length === 0
      || entry.tools.some((tool) => typeof tool !== 'string' || tool.trim() === '')) {
      return { ok: false, error: `hook "${id}": tools must be a non-empty array of tool names` }
    }
  }
  let maxTurns
  if (entry.maxTurns !== undefined && entry.maxTurns !== null) {
    const parsed = Number(entry.maxTurns)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
      return { ok: false, error: `hook "${id}": maxTurns must be a positive integer (1-200)` }
    }
    maxTurns = parsed
  }

  return {
    ok: true,
    hook: {
      id,
      on,
      action,
      [action]: actionText,
      match: entry.match === undefined || entry.match === null
        ? undefined
        : (typeof entry.match === 'string' ? entry.match.trim() : { ...entry.match }),
      timeoutMs,
      async: asyncMode,
      cwd: entry.cwd === undefined || entry.cwd === null ? undefined : String(entry.cwd).trim() || undefined,
      stdin: entry.stdin !== false,
      block: entry.block !== false,
      enabled: entry.enabled !== false,
      once: entry.once === true,
      shell: entry.shell === undefined || entry.shell === null ? undefined : String(entry.shell).trim() || undefined,
      args: entry.args === undefined || entry.args === null ? undefined : [...entry.args],
      env: entry.env === undefined || entry.env === null ? undefined : { ...entry.env },
      headers: entry.headers === undefined || entry.headers === null ? undefined : { ...entry.headers },
      allowedEnvVars: entry.allowedEnvVars === undefined || entry.allowedEnvVars === null
        ? undefined
        : [...entry.allowedEnvVars],
      model: entry.model === undefined || entry.model === null ? undefined : String(entry.model).trim() || undefined,
      tools: entry.tools === undefined || entry.tools === null
        ? undefined
        : [...new Set(entry.tools.map((tool) => String(tool).trim()).filter(Boolean))],
      maxTurns,
      rewakeMessage: entry.rewakeMessage === undefined || entry.rewakeMessage === null
        ? undefined
        : String(entry.rewakeMessage).slice(0, 500) || undefined,
      rewakeSummary: entry.rewakeSummary === undefined || entry.rewakeSummary === null
        ? undefined
        : String(entry.rewakeSummary).slice(0, 300) || undefined,
      msg: entry.msg ?? entry.statusMessage ?? undefined,
    },
  }
}

export const SOURCE_KINDS = Object.freeze(['user', 'proj', 'local', 'cfg'])

function sourceSlug(source, kind) {
  const explicit = String(kind ?? '').toLowerCase()
  if (SOURCE_KINDS.includes(explicit)) return explicit
  const text = String(source ?? '').toLowerCase()
  // Leading "kind:..." / "kind-..." labels win (merge layer passes them).
  const leading = text.match(/^(user|proj(?:ect)?|local|cfg|config|hook)\b/)
  if (leading) {
    const word = leading[1]
    if (word === 'user') return 'user'
    if (word === 'local') return 'local'
    if (word === 'cfg' || word === 'config') return 'cfg'
    return 'proj'
  }
  if (text.includes('local')) return 'local'
  if (text.includes('proj')) return 'proj'
  // NOTE: no '.dsh' rule here on purpose — both the user file
  // ($DSH_HOME/hooks.json) and project files (${cwd}/.dsh/...) contain
  // ".dsh", so sniffing it mislabels ~/.dsh/hooks.json as proj.
  if (text.includes('user') || text.includes('home') || text.includes('dsh_home')) return 'user'
  if (text.includes('inline') || text.includes('config') || text.includes('patch')) return 'cfg'
  return 'hook'
}

export function parseHooks(rawHooks, source = 'hooks', kind) {
  if (rawHooks === undefined || rawHooks === null) return { hooks: [], errors: [] }
  // Qoder object shape {Event: [...]} is rejected loudly: this plugin owns
  // its format and never silently reinterprets a foreign schema.
  if (isPlainObject(rawHooks)) {
    return {
      hooks: [],
      errors: [`${source}: plus format needs a hooks array; Qoder object shape is not accepted (see README)`],
    }
  }
  if (!Array.isArray(rawHooks)) return { hooks: [], errors: [`${source}: hooks must be an array`] }
  const hooks = []
  const errors = []
  const seen = new Set()
  const slug = sourceSlug(source, kind)
  rawHooks.forEach((entry, index) => {
    const hasExplicitId = isPlainObject(entry)
      && ((typeof entry.id === 'string' && entry.id.trim() !== '')
        || (typeof entry.name === 'string' && entry.name.trim() !== ''))
    const result = normalizeHook(entry, index)
    if (!result.ok) {
      errors.push(`${source}: ${result.error}`)
      return
    }
    // Auto ids carry the file source so multi-file merges never collide on
    // hook-1/hook-2. Explicit ids stay untouched; cross-file duplicates are
    // resolved by the merge layer (later source wins), not here.
    if (!hasExplicitId) result.hook.id = `${slug}-${index + 1}`
    if (seen.has(result.hook.id)) {
      errors.push(`${source}: hook "${result.hook.id}": duplicate id (later entry dropped)`)
      return
    }
    seen.add(result.hook.id)
    hooks.push(result.hook)
  })
  return { hooks, errors }
}
