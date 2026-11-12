/**
 * dsh-hook-plus config loading + merge.
 *
 * Sources (low -> high precedence, later duplicate id wins):
 *   1. user   $DSH_HOME/hooks.json
 *   2. cfg    inline config.hooks (profile patch)
 *   3. proj   ${cwd}/.dsh/hooks.json
 *   4. local  ${cwd}/.dsh/hooks.local.json
 *
 * Missing files are silently skipped. Invalid JSON / non-array shapes are
 * reported as errors but never throw. Within one file a duplicate id is an
 * error (later entry dropped); across files the higher-precedence source
 * replaces the lower one (override noted in `overrides`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { parseHooks } from './plus-format.js'

export function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

export function hookFilePaths({ home = dshHome(), cwd = process.cwd() } = {}) {
  return {
    user: join(home, 'hooks.json'),
    proj: join(resolve(String(cwd)), '.dsh', 'hooks.json'),
    local: join(resolve(String(cwd)), '.dsh', 'hooks.local.json'),
  }
}

export function readHooksFile(file) {
  if (!existsSync(file)) return { raw: undefined, parsed: undefined, error: undefined, missing: true }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw: undefined, parsed: undefined, error: `${file}: top-level JSON must be an object with a hooks array`, missing: false }
    }
    return { raw: parsed.hooks, parsed, error: undefined, missing: false, path: file }
  } catch (error) {
    return {
      raw: undefined, parsed: undefined,
      error: `${file}: invalid JSON (${error instanceof Error ? error.message : String(error)}); file skipped`,
      missing: false,
    }
  }
}

/**
 * Merge parsed lists in precedence order. Later lists override earlier ones
 * on duplicate id; the override is recorded, not errored.
 */
export function mergeHookLists(lists) {
  const byId = new Map()
  const order = []
  const overrides = []
  for (const { kind, hooks } of lists) {
    for (const hook of hooks) {
      if (byId.has(hook.id)) {
        const prev = byId.get(hook.id)
        overrides.push(`hook "${hook.id}": ${kind} overrides ${prev.from}`)
        const at = order.indexOf(hook.id)
        if (at !== -1) order.splice(at, 1)
      }
      byId.set(hook.id, { hook, from: kind })
      order.push(hook.id)
    }
  }
  return { hooks: order.map((id) => byId.get(id).hook), overrides }
}

export function loadAll({ config = {}, home, cwd } = {}) {
  const paths = hookFilePaths({ home: home ?? dshHome(), cwd: cwd ?? process.cwd() })
  const errors = []
  // File-level settings: each hooks file may carry a top-level "debug"
  // object; later sources win. Currently: { dumpSessionKeys: <abs path> }.
  const settings = {}

  const parsed = []
  const seenFiles = new Set()
  const readAndParse = (file, kind) => {
    // Same physical file under two roles (e.g. cwd inside $DSH_HOME) must
    // load once: otherwise id-less hooks would register AND run twice.
    const key = String(file).toLowerCase()
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    const read = readHooksFile(file)
    if (read.error) errors.push(read.error)
    if (read.parsed !== undefined && read.parsed !== null
      && typeof read.parsed.debug === 'object' && read.parsed.debug !== null && !Array.isArray(read.parsed.debug)) {
      Object.assign(settings, read.parsed.debug)
    }
    if (read.raw === undefined) return
    const result = parseHooks(read.raw, file, kind)
    errors.push(...result.errors)
    parsed.push({ kind, hooks: result.hooks })
  }

  readAndParse(paths.user, 'user')
  const inline = parseHooks(config.hooks, 'config.hooks (inline)', 'cfg')
  errors.push(...inline.errors)
  parsed.push({ kind: 'cfg', hooks: inline.hooks })
  readAndParse(paths.proj, 'proj')
  readAndParse(paths.local, 'local')

  const merged = mergeHookLists(parsed)
  return {
    files: { ...paths, inline: 'config.hooks' },
    hooks: merged.hooks,
    errors,
    overrides: merged.overrides,
    settings,
  }
}
