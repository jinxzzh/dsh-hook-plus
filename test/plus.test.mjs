import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { parseHooks } from '../lib/plus-format.js'
import { loadAll } from '../lib/plus-load.js'
import { matchHook } from '../lib/plus-match.js'

const NODE = JSON.stringify(process.execPath)

// Isolate from the developer machine: unit tests must never load the real
// $DSH_HOME/hooks.json (which may contain e2e hooks during local verification).
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'hook-plus-test-home-'))

class FakeCtx {
  constructor(sessionExtra = {}) {
    this.handlers = new Map()
    this.commands = []
    this.warnings = []
    this.notes = []
    this.sessionExtra = sessionExtra
    this.logger = { info: () => {}, warn: (line) => this.warnings.push(line) }
  }
  session(extra = {}) {
    return { id: 's1', header: { cwd: '/w' }, injectMessage: (m) => this.notes.push(m), ...this.sessionExtra, ...extra }
  }
  on(event, handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {}
  }
  effect(register) { return register() }
  inject(names, callback) { callback({ commands: { register: (d) => this.commands.push(d) } }) }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('format: action inference, timeouts, duplicate ids', () => {
  const bad = parseHooks([{ on: 'PreToolUse' }])
  assert.equal(bad.hooks.length, 0)
  assert.match(bad.errors[0], /one action required/)
  const both = parseHooks([{ id: 'x', on: 'PreToolUse', run: 'a', call: 'https://e.com' }])
  assert.match(both.errors[0], /only one action/)
  const timeouts = parseHooks([
    { id: 'r', on: 'PreToolUse', run: 'a' },
    { id: 'c', on: 'Stop', check: 'x' },
    { id: 't', on: 'PreToolUse', run: 'a', timeout: 30 },
  ])
  assert.deepEqual(timeouts.hooks.map((h) => h.timeoutMs), [30_000, 120_000, 30_000])
  const dup = parseHooks([
    { id: 'a', on: 'PreToolUse', run: 'true' },
    { id: 'a', on: 'Stop', run: 'true' },
  ])
  assert.equal(dup.hooks.length, 1)
  assert.match(dup.errors[0], /duplicate id/)
})

test('load: user < inline < proj < local, later wins', () => {
  const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hook-cwd-'))
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: [{ id: 'x', on: 'PreToolUse', run: 'echo user' }] }))
  const r = loadAll({ config: { hooks: [{ id: 'x', on: 'PreToolUse', run: 'echo inline' }] }, home, cwd })
  assert.equal(r.hooks.find((h) => h.id === 'x').run, 'echo inline')
  assert.match(r.overrides.join(';'), /cfg overrides user/)
})

test('load: same file under two roles loads once', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hook-cwd-'))
  const home = join(cwd, '.dsh')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: [{ on: 'PreToolUse', run: 'true' }] }))
  // user file and proj file resolve to the same path here: must not double-register.
  const r = loadAll({ config: {}, home, cwd })
  assert.equal(r.hooks.length, 1)
})

test('match: tool names are case-insensitive, globs and groups work', () => {
  assert.equal(matchHook({ on: 'PreToolUse', match: 'Bash' }, { tool_name: 'bash' }, 'bash'), true)
  assert.equal(matchHook({ on: 'PreToolUse', match: 'Write|Edit' }, { tool_name: 'edit' }, 'edit'), true)
  assert.equal(matchHook({ on: 'PreToolUse', match: '^(Write|Edit)$' }, { tool_name: 'edit' }, 'edit'), true)
  assert.equal(matchHook({ on: 'PreToolUse', match: 'Bash(git *)' }, { tool_name: 'bash', tool_input: { command: 'git status' } }, 'bash'), true)
  assert.equal(matchHook({ on: 'FileChanged', match: '*.[jt]s' }, { file_path: '/a/b.ts' }, undefined), true)
  assert.equal(matchHook({ on: 'SubagentStop', match: { stop_hook_active: false } }, { stop_hook_active: false }, undefined), true)
})

test('pre-tool: exit 2 denies with a model-visible summary', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [{ id: 'guard', on: 'PreToolUse', match: 'Bash', run: `${NODE} -e "console.error('no rm'); process.exit(2)"` }] })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  const denied = await pre(
    { name: 'bash', arguments: { command: 'rm -rf x' }, agent: { session: ctx.session() } },
    () => ({ kind: 'allow' }),
  )
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /\[Hook dsh-hook-plus\] id=guard/)
  assert.match(denied.reason, /no rm/)
})

test('pre-tool: updatedInput rewrites args; background never blocks', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [
    { id: 'rw', on: 'PreToolUse', match: 'Bash', run: `${NODE} -e "console.log(JSON.stringify({updatedInput:{command:'echo safe'}}))"` },
    { id: 'bg', on: 'PreToolUse', match: 'Read', async: 'background', run: `${NODE} -e "setTimeout(()=>{},5000)"` },
  ] })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  const exec = { name: 'bash', arguments: { command: 'rm -rf x' }, agent: { session: ctx.session() } }
  const started = Date.now()
  const out = await pre(exec, () => ({ kind: 'allow' }))
  assert.equal(exec.arguments.command, 'echo safe')
  assert.equal(out.kind, 'allow')
  const bgExec = { name: 'read', arguments: {}, agent: { session: ctx.session() } }
  await pre(bgExec, () => ({ kind: 'allow' }))
  assert.ok(Date.now() - started < 4000)
})

test('post-tool: sync updatedOutput replaces content', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [{ id: 'po', on: 'PostToolUse', match: 'Write', async: 'sync', run: `${NODE} -e "console.log(JSON.stringify({updatedOutput:'LINT-OK'}))"` }] })
  const post = ctx.handlers.get('tools/post-execute')[0]
  const result = { isError: false, content: [{ type: 'text', text: 'orig' }] }
  await post({ name: 'write', arguments: {}, agent: { session: ctx.session() } }, result, () => 'm')
  assert.equal(result.content[0].text, 'LINT-OK')
})

test('stop: sync deny wakes the session; exit 1 stays silent', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [
    { id: 'stopper', on: 'Stop', run: `${NODE} -e "console.error('uncommitted'); process.exit(2)"` },
    { id: 'flaky', on: 'Stop', run: `${NODE} -e "process.exit(1)"` },
  ] })
  ctx.handlers.get('session/event')[0](ctx.session(), { type: 'turn/end', data: { reason: 'completed' } })
  await wait(800)
  assert.equal(ctx.notes.length, 1)
  assert.match(ctx.notes[0], /stopper/)
})

test('session passthrough: canonical events fire; prompt mirrored from content', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [
    { id: 'ss', on: 'SessionStart', async: 'sync', run: `${NODE} -e "console.error('started!'); process.exit(2)"` },
    { id: 'pm', on: 'UserPromptSubmit', match: '.*sort.*', async: 'sync', run: `${NODE} -e "console.error('matched prompt'); process.exit(2)"` },
  ] })
  const handler = ctx.handlers.get('session/event')[0]
  handler(ctx.session(), { type: 'SessionStart', data: { source: 'startup' } })
  handler(ctx.session(), { type: 'user/message', data: { content: [{ type: 'text', text: 'write a sort function' }] } })
  await wait(800)
  assert.equal(ctx.notes.length, 2)
  assert.match(ctx.notes.join('\n'), /started!/)
  assert.match(ctx.notes.join('\n'), /matched prompt/)
})

test('pre-tool timeout fail-closes; pre notes flush to post content', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [
    { id: 'slow', on: 'PreToolUse', match: 'Read', timeout: '300ms', run: `${NODE} -e "setTimeout(()=>{}, 5000)"` },
    { id: 'rw', on: 'PreToolUse', match: 'Bash', run: `${NODE} -e "console.log(JSON.stringify({updatedInput:{command:'echo safe'}, additionalContext:'sanitized'}))"` },
  ] })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  const post = ctx.handlers.get('tools/post-execute')[0]
  const slowDenied = await pre(
    { name: 'read', arguments: {}, agent: { session: ctx.session() } },
    () => ({ kind: 'allow' }),
  )
  assert.equal(slowDenied.kind, 'deny')
  const exec = { name: 'bash', arguments: { command: 'rm -rf x' }, agent: { session: ctx.session() } }
  const out = await pre(exec, () => ({ kind: 'allow' }))
  assert.equal(out.kind, 'allow')
  const result = { isError: false, content: [] }
  await post(exec, result, () => 'm')
  const texts = result.content.map((block) => block.text).join('\n')
  assert.match(texts, /updated tool input/)
  assert.match(texts, /sanitized/)
})

test('rewake wakes via agent.followup (in-house path)', async () => {
  const ctx = new FakeCtx()
  const followed = []
  const agent = { session: ctx.session(), followup: (message) => followed.push(message) }
  apply(ctx, {
    hooks: [{ id: 'waker', on: 'PreToolUse', match: 'Bash', async: 'rewake', run: `${NODE} -e "console.error('wake me'); process.exit(2)"` }],
  })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  // background rewake never blocks the tool itself
  const out = await pre(
    { name: 'bash', arguments: { command: 'x' }, agent },
    () => ({ kind: 'allow' }),
  )
  assert.equal(out.kind, 'allow')
  await wait(600)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].role, 'user')
  assert.equal(followed[0].source.kind, 'user')
  assert.match(followed[0].content[0].text, /wake me/)
  assert.match(followed[0].content[0].text, /\[Hook dsh-hook-plus\] id=waker/)
  assert.equal(typeof followed[0].id, 'string')
})

test('rewake falls back to session injection when no agent is known', async () => {
  const ctx = new FakeCtx()
  apply(ctx, {
    hooks: [{ id: 'waker', on: 'Stop', async: 'rewake', run: `${NODE} -e "console.error('wake me'); process.exit(2)"` }],
  })
  ctx.handlers.get('session/event')[0](ctx.session(), { type: 'turn/end', data: { reason: 'completed' } })
  await wait(600)
  // FakeCtx sessions expose injectMessage: legacy probing path delivers.
  assert.equal(ctx.notes.length, 1)
  assert.match(ctx.notes[0], /wake me/)
})

test('rewake stays silent on plain exit 1 (no followup, no note)', async () => {
  const ctx = new FakeCtx()
  const followed = []
  const agent = { session: ctx.session(), followup: (message) => followed.push(message) }
  apply(ctx, {
    hooks: [{ id: 'flaky', on: 'PreToolUse', match: 'Bash', async: 'rewake', run: `${NODE} -e "process.exit(1)"` }],
  })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  await pre({ name: 'bash', arguments: { command: 'x' }, agent }, () => ({ kind: 'allow' }))
  await wait(600)
  assert.equal(followed.length, 0)
  assert.equal(ctx.notes.length, 0)
})

test('once hooks are consumed; /hooks shows runs', async () => {
  const ctx = new FakeCtx()
  apply(ctx, { hooks: [{ id: 'one', on: 'PreToolUse', once: true, run: `${NODE} -e "process.exit(0)"` }] })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  const exec = { name: 'bash', arguments: {}, agent: { session: ctx.session() } }
  await pre(exec, () => ({ kind: 'allow' }))
  await pre(exec, () => ({ kind: 'allow' }))
  const cmd = ctx.commands.find((entry) => entry.name === 'hooks')
  assert.match(cmd.handler().text, /consumed/)
  assert.match(cmd.handler().text, /Recent runs/)
})
