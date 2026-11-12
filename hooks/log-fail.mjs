#!/usr/bin/env node
/**
 * dsh-hook-plus failure recorder: append one line per failed tool call.
 * Usage: node log-fail.mjs [>> ~/.dsh/hooks/failures.log]
 * Reads the hook payload JSON from stdin, prints a single TSV line.
 */
import { readFileSync } from 'node:fs'

let body = ''
try {
  body = readFileSync(0, 'utf8')
} catch {
  process.exit(0)
}
let payload = null
try {
  payload = body.trim() === '' ? null : JSON.parse(body)
} catch {
  process.exit(0)
}
if (!payload) process.exit(0)
const tool = payload.tool_name ?? '?'
const args = payload.tool_input ?? payload.args ?? {}
const firstArg = typeof args === 'string'
  ? args
  : (args.command ?? args.file_path ?? args.path ?? JSON.stringify(args)).toString()
const error = (payload.error ?? payload.tool_response?.error ?? '').toString().replace(/\s+/g, ' ')
console.log([new Date().toISOString(), tool, firstArg.slice(0, 200), error.slice(0, 300)].join('\t'))
