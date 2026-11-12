#!/usr/bin/env node
/**
 * dsh-hook-plus production guard: block genuinely destructive commands.
 * Reads the hook payload JSON from stdin, exits 2 with a reason on match,
 * exits 0 otherwise. Keep patterns narrow: false positives stall real work.
 *
 * Trigger hooks should pre-filter (e.g. match "Bash(rm *)"), this script
 * makes the final precise decision.
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

const input = payload?.tool_input ?? payload?.args ?? {}
const command = [input.command, input.file_path, input.path, input.filePath]
  .filter((v) => typeof v === 'string')
  .join('\n')
if (command === '') process.exit(0)

const RULES = [
  // rm -rf against /, ~, home, drive roots, or bare globs
  [/\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|%USERPROFILE%|[A-Za-z]:[\\/]?|\*)/i, 'refusing recursive delete of system/home/drive root'],
  // fork bomb
  [/:\(\)\s*\{\s*:\|\:&\s*\}\s*;?\s*:/, 'refusing fork bomb'],
  // raw disk writes
  [/\bdd\b[^|;]*\bof=\/dev\//, 'refusing raw disk write'],
  [/\bmkfs\b/, 'refusing filesystem format'],
  // Windows: recursive/forced removal under system dirs, volume format
  [/Remove-Item\b.*(?:-Recurse|-Force).*\\?(Windows|System32|Program Files)/i, 'refusing removal under system directories'],
  [/\bFormat-Volume\b/i, 'refusing volume format'],
]

for (const [pattern, reason] of RULES) {
  if (pattern.test(command)) {
    console.error(`${reason}: ${command.split('\n')[0].slice(0, 200)}`)
    process.exit(2)
  }
}
process.exit(0)
