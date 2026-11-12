/**
 * dsh-hook-plus matcher engine (F2).
 *
 * Two forms, one engine:
 *   string: "Bash" | "Write|Edit" | "*" | "mcp__.*" | "Bash(git *)"
 *   object: { tool: "Write|Edit", arg: "*.ts", reason: "error",
 *             stop_hook_active: false, "data.n": { gt: 10000 } }
 *
 * String semantics (Qoder-compatible):
 *   - "" / undefined / "*"            -> match all
 *   - "a|b"                           -> any alternative matches
 *   - alternative with regex metachars -> RegExp test (unicode)
 *   - otherwise                        -> exact equality
 *   - trailing "(...)"                 -> main-arg glob (Qoder `if` form).
 *     Regex tool patterns containing parens must use object form instead:
 *     { tool: "mcp__(.*)" }.
 *
 * Object semantics:
 *   - key "tool" -> matcher syntax against the tool name (tool events only;
 *     on non-tool events a present tool/arg constraint fails closed).
 *   - key "arg"  -> glob against the tool's primary arg (command | file_path
 *     | path | first string arg).
 *   - other keys -> dotted payload paths; string = regex, number/boolean =
 *     exact equality, {gt,gte,lt,lte,eq} = numeric comparison.
 */

const NUMBER_COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq'])

// Per-event field that a bare string match tests (Qoder matcher column).
// "__tool__" = tool-name path (tool events handle arg parens separately).
export const MATCHER_FIELD = Object.freeze({
  SessionStart: 'source',
  SessionEnd: 'reason',
  UserPromptSubmit: 'prompt',
  PreToolUse: '__tool__',
  PostToolUse: '__tool__',
  PostToolUseFailure: '__tool__',
  PermissionRequest: '__tool__',
  PermissionDenied: '__tool__',
  Stop: null,
  StopFailure: 'error_type',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
  PreCompact: 'trigger',
  PostCompact: 'trigger',
  Notification: 'notification_type',
  InstructionsLoaded: 'load_reason',
  ConfigChange: 'source',
  CwdChanged: null,
  FileChanged: '__basename__',
  WorktreeCreate: null,
  WorktreeRemove: null,
  Elicitation: 'mcp_server_name',
  ElicitationResult: 'mcp_server_name',
})

export function pathSegments(path) {
  if (typeof path !== 'string' || path.trim() === '') return []
  return path.split('.').map((segment) => segment.trim()).filter(Boolean)
}

export function getByPath(value, path) {
  const segments = pathSegments(path)
  let current = value
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * Decide regex vs glob vs exact for ONE alternative (no top-level "|").
 * - grouped/anchored/operator syntax  -> native regex
 * - ".*"/".?" idioms                  -> native regex
 * - "*"/"?"/"[...]" wildcards         -> glob (classes handled by globToRegExp)
 * - otherwise                         -> exact string equality
 */
function matchOne(alt, actual, ci = false) {
  if (alt === '*') return true
  const test = (pattern) => {
    try {
      return new RegExp(pattern, ci ? 'iu' : 'u').test(actual)
    } catch {
      return false
    }
  };
  const norm = (str) => (ci ? str.toLowerCase() : str)
  const hasWildcard = alt.includes('*') || alt.includes('?')
  const hasRegexIdiom = alt.includes('.*') || alt.includes('.?')
  if (hasWildcard && !hasRegexIdiom && !alt.startsWith('^') && !/[+(){}\\^$]/.test(alt)) {
    return test(`^(?:${globToRegExp(alt)})$`)
  }
  if (hasRegexIdiom || /[+()[\]{}\\^$]/.test(alt)) return test(alt)
  if (hasWildcard) return test(`^(?:${globToRegExp(alt)})$`)
  return norm(actual) === norm(alt)
}

function tryRegexTest(pattern, text) {
  try {
    return new RegExp(pattern, 'u').test(text)
  } catch {
    return false
  }
}

/** Qoder matcher syntax against one string value. Set ci:true for tool names:
 *  DSH hosts pass lowercase exec.name ("bash") while configs read naturally
 *  ("Bash") — tool matching must not care. File paths stay case-sensitive. */
export function matchField(pattern, value, { ci = false } = {}) {
  if (pattern === undefined || pattern === null) return true
  const text = String(pattern).trim()
  if (text === '' || text === '*') return true
  const actual = value === undefined || value === null ? '' : String(value)
  const fold = (str) => (ci ? str.toLowerCase() : str)
  const alternatives = text.split('|').map((item) => item.trim()).filter((item) => item !== '')
  if (alternatives.length === 0) return true
  if (alternatives.some((alt) => matchOne(alt, actual, ci))) return true
  // Grouped regex such as "^(Write|Edit)$" or "mcp__(github|gitlab)_.*"
  // is shattered by the split above; retry the intact pattern as one regex.
  // Plain "a|b" lists never reach here as a false positive (no parens).
  if (/[()]/.test(text)) {
    try {
      return new RegExp(text, ci ? 'iu' : 'u').test(actual)
    } catch {
      return false
    }
  }
  return false
}

/** Split "ToolExpr" / "ToolExpr(argGlob)". Returns { tool, arg }. */
export function parseShorthand(str) {
  const text = String(str ?? '').trim()
  const paren = /^(.*?)\(([^()]*)\)$/.exec(text)
  if (paren) {
    return { tool: paren[1].trim() || '*', arg: paren[2].trim() }
  }
  return { tool: text || '*', arg: undefined }
}

/** Minimal glob: "*" -> any run, "?" -> one char, "[...]" classes. */
export function globToRegExp(glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') out += '.*'
    else if (char === '?') out += '.'
    else if (char === '[') {
      const close = glob.indexOf(']', index + 1)
      if (close === -1) out += '\\['
      else {
        out += glob.slice(index, close + 1)
        index = close
      }
    } else if ('\\.+^${}()|'.includes(char)) out += `\\${char}`
    else out += char
  }
  return out
}

export function matchGlob(glob, value) {
  if (glob === undefined || glob === null || String(glob) === '') return true
  const actual = value === undefined || value === null ? '' : String(value)
  return tryRegexTest(`^(?:${globToRegExp(String(glob))})$`, actual)
}

export function primaryArg(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return typeof args === 'string' ? args : undefined
  }
  for (const key of ['command', 'file_path', 'path']) {
    if (typeof args[key] === 'string') return args[key]
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string') return value
  }
  return undefined
}

function matchValue(expected, actual) {
  if (expected === undefined || expected === null) return true
  if (typeof expected === 'boolean') return actual === expected
  if (typeof expected === 'number') {
    const numeric = typeof actual === 'number' ? actual : Number(actual)
    return Number.isFinite(numeric) && numeric === expected
  }
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    const numeric = Number(actual)
    if (!Number.isFinite(numeric)) return false
    for (const [operator, raw] of Object.entries(expected)) {
      if (!NUMBER_COMPARATORS.has(operator)) return false
      const target = Number(raw)
      if (!Number.isFinite(target)) return false
      if (operator === 'gt' && !(numeric > target)) return false
      if (operator === 'gte' && !(numeric >= target)) return false
      if (operator === 'lt' && !(numeric < target)) return false
      if (operator === 'lte' && !(numeric <= target)) return false
      if (operator === 'eq' && numeric !== target) return false
    }
    return true
  }
  if (typeof expected !== 'string') return false
  if (actual === undefined || actual === null) return false
  const text = typeof actual === 'object' ? JSON.stringify(actual) : String(actual)
  return tryRegexTest(expected, text)
}

export function basenameOf(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return ''
  return filePath.split(/[\\/]/).pop()
}

/**
 * Whether one hook matches a runtime payload.
 * @param hook normalized plus hook ({ on, match, enabled }).
 * @param payload plain JSON payload (snake_case Qoder fields + tool_name).
 * @param toolName tool name for tool events (else undefined).
 */
export function matchHook(hook, payload = {}, toolName) {
  if (hook.enabled === false) return false
  const match = hook.match
  if (match === undefined || match === null) return true

  const args = payload.tool_input ?? payload.args
  const primary = primaryArg(args)
  const tool = toolName ?? payload.tool_name

  if (typeof match === 'string') {
    const field = MATCHER_FIELD[hook.on]
    if (field === '__tool__') {
      const { tool: toolPattern, arg } = parseShorthand(match)
      // Tool names are case-insensitive: DSH passes "bash", configs say "Bash".
      if (!matchField(toolPattern, tool, { ci: true })) return false
      if (arg !== undefined && !matchGlob(arg, primary)) return false
      return true
    }
    if (field === '__basename__') {
      return matchField(match, basenameOf(payload.file_path))
    }
    if (field === null || field === undefined) {
      // Qoder defines no matcher for this event: only "*" matches.
      return match.trim() === '' || match.trim() === '*'
    }
    return matchField(match, getByPath(payload, field))
  }

  // Object form.
  for (const [key, expected] of Object.entries(match)) {
    if (key === 'tool') {
      if (tool === undefined || !matchField(expected, tool, { ci: true })) return false
      continue
    }
    if (key === 'arg') {
      if (typeof expected === 'string') {
        if (!matchGlob(expected, primary)) return false
        continue
      }
      if (!matchValue(expected, primary)) return false
      continue
    }
    if (!matchValue(expected, getByPath(payload, key))) return false
  }
  return true
}
