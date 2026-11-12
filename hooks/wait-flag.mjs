#!/usr/bin/env node
/**
 * dsh-hook-plus wait-flag: event-driven completion waiter (no polling sleeps).
 *
 * Usage: node wait-flag.mjs <flagfile> [--timeout-ms N]
 * Watches the flag file's directory with fs.watch; the moment the file
 * appears or changes, prints its content as the completion summary to
 * stderr and exits 2 (deny = wake the model immediately via rewake).
 * Exit 1 on internal timeout (logged only, never wakes).
 *
 * Pair with a hook:
 *   { "id": "wait-long-job", "on": "PostToolUse",
 *     "match": { "tool": "pwsh", "arg": "*train.py*" },
 *     "async": "rewake", "timeout": "10m",
 *     "run": "node \"C:/Users/zhai/.dsh/hooks/wait-flag.mjs\" \"C:/done.flag\"" }
 * Launch pattern: <your-program> ; echo DONE > C:/done.flag
 * (delete the flag before relaunching).
 */
import { existsSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const flagArg = process.argv[2]
const timeoutFlag = process.argv.indexOf('--timeout-ms')
const timeoutMs = timeoutFlag === -1 ? 9 * 60_000 : Number(process.argv[timeoutFlag + 1])

if (!flagArg) {
  console.error('wait-flag: missing <flagfile> argument')
  process.exit(1)
}
// Node's resolve() does not expand ~ (unlike shells), so do it here:
// hook `run` strings may also carry a literal ~/ path on Windows shells.
const expanded = flagArg === '~' ? homedir()
  : (flagArg.startsWith('~/') || flagArg.startsWith('~\\')) ? join(homedir(), flagArg.slice(2))
  : flagArg
const flag = resolve(expanded)

function finish(exitCode, message) {
  console.error(message)
  process.exit(exitCode)
}

function readFlag() {
  try {
    return readFileSync(flag, 'utf8').trim()
  } catch {
    return null
  }
}

// Already done before we started watching.
const existing = readFlag()
if (existing !== null && existing !== '') {
  finish(2, `program finished (flag already present):\n${existing.slice(0, 2000)}`)
}

let done = false
const timer = setTimeout(() => {
  if (done) return
  done = true
  watcher?.close()
  finish(1, `wait-flag: timed out after ${timeoutMs}ms waiting for ${flag}`)
}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 9 * 60_000)

let watcher = null
try {
  watcher = watch(dirname(flag), (eventType, filename) => {
    if (done) return
    if (filename !== undefined && !flag.endsWith(filename)) return
    const content = readFlag()
    if (content === null || content === '') return
    done = true
    clearTimeout(timer)
    watcher?.close()
    finish(2, `program finished:\n${content.slice(0, 2000)}`)
  })
  watcher.on('error', () => {})
} catch (error) {
  clearTimeout(timer)
  finish(1, `wait-flag: cannot watch ${flag}: ${error instanceof Error ? error.message : String(error)}`)
}
