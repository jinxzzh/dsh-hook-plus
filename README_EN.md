# dsh-hook-plus

[中文](./README.md)

Self-owned lifecycle hooks for DeepSeek Harness, functionally aligned with Qoder Hooks. One hook = one event + one action. No `type:` tax: the action key infers it.

```yaml
- id: guard-rm
  on: PreToolUse
  match: Bash(git *)
  run: ~/.dsh/hooks/block.sh
- id: lint
  on: PostToolUse
  match: { tool: Write|Edit, arg: "*.ts" }
  run: npx eslint --fix
  timeout: 30s
  async: background
- id: ping
  on: Stop
  call: https://example.com/hook
```

## Format

| Field | Required | Meaning |
|---|---|---|
| `id` | yes (auto `user-1`/`proj-2`/… with source prefix) | unique; same-file dup drops, cross-file later source wins |
| `on` | yes | one of the 22 canonical events (`SessionStart…ElicitationResult`); lite aliases accepted on input |
| `run`/`call`/`ask`/`check` | exactly one | shell command / http(s) URL / judge prompt / sub-agent prompt |
| `match` | no | string shorthand (`Bash`, `Write\|Edit`, `*`, `mcp__.*`, `Bash(git *)`) or object (`tool` = matcher syntax, `arg` = glob, other keys = payload paths with regex / boolean+number exact / `{gt,gte,lt,lte,eq}`) |
| `timeout` | no | `500ms`/`30s`/`5m`; bare numbers are **seconds**; defaults run 30s / call 15s / ask 60s / check 120s, cap 10m |
| `async` | no | `sync` (may block where the seam allows) / `background` (fire-and-forget) / `rewake` (background, wakes the model only on explicit deny) |
| `args` | no | array = exec form (no shell, `${VAR}` expanded); absent = shell form (shell expands, `~/` expanded by plugin) |
| `shell/env/headers/allowedEnvVars` | no | shell override; extra env; http headers with `${ENV}` interpolation gated by `allowedEnvVars` |
| `model/tools/maxTurns` | no | ask/check: model override, sub-agent tool whitelist, 1–200 |
| `msg/rewakeMessage/rewakeSummary` | no | spinner text; rewake note (summary ≤300 chars) |
| `cwd/stdin/block/enabled/once` | no | `session` = session cwd; `stdin:false` skips payload; `block:false` observes only; `once` consumes after first success |

Tool names match case-insensitively (`Bash` matches DSH's `bash`). File paths stay case-sensitive. Timeouts are fail-closed: a hanging interceptor denies instead of allowing. Bare-number timeouts are seconds.

## Sources (low → high, later duplicate id wins)

1. `$DSH_HOME/hooks.json` (user)
2. inline `config.hooks` (profile patch)
3. `${cwd}/.dsh/hooks.json` (project)
4. `${cwd}/.dsh/hooks.local.json` (project-local)

Missing files are skipped; bad JSON is reported, never thrown. `/hooks` shows sources, overrides, warnings, recent runs. `/hooks-reload` re-reads everything.

## Events → DSH seams

| Hook event | Seam | Blocking? |
|---|---|---|
| `PreToolUse` | `tools/pre-execute` | yes (`exit 2` / JSON `decision:deny` / `ok:false` / `continue:false` deny; `updatedInput` rewrites args) |
| `PostToolUse` / `PostToolUseFailure` (by `result.isError`) | `tools/post-execute` | no; sync hooks may set `updatedOutput` / `additionalContext` |
| `Stop` | `session/event` `turn/end` | broadcast: deny becomes a wake-up note |
| `UserPromptSubmit` | `session/event` `user/message` | observe-only (broadcast cannot block); deny becomes a wake-up note; message text is mirrored to `prompt` so string matchers see it |
| others (Session*, Permission*, Subagent*, Compact, Notification, …) | `session/event` with the canonical type | parsed and matchable whenever a host emits them (wake only on explicit deny) |

`step/end` and `session/title` have no Qoder counterpart, are rejected at config validation (write `Stop` instead), and unknown session types warn once and skip.

## Hook answers (flat, no wrapper)

Scripts (`exit 0` + stdout JSON) and `call` responses use flat fields: `decision: allow|deny|ask`, `ok`, `continue`, `reason`, `updatedInput`, `updatedOutput`, `additionalContext`, `action`, `content`, `retry`, `clearContext`, `worktreePath`, `systemMessage`. `exit 2` = deny (`stderr` is the reason). Other nonzero exits without JSON = error (logged, never wakes the model). `ask` without an approval UI blocks as `[ask] …`.

Every denial, rewrite (`updatedInput`), injection (`additionalContext`) and rewake carries a structured block so the MODEL sees it. Pre-execute notes are stashed and flushed into `result.content` at post-execute (even with zero post hooks), so a rewrite is never silent:

```text
[Hook dsh-hook-plus] id=guard | on=PreToolUse | action=run | tool=bash | result=blocked(exit 2) | 66ms
Reason: no rm
```

## ask / check

`ask: "<prompt>"` (event JSON appended) and `check: "<prompt with $ARGUMENTS>"` (missing placeholder = appended automatically) dispatch to the injected `evaluator` (`config.evaluator` function wins; else `config.llm` `{ baseUrl, apiKey?, model }` or `DSH_HOOK_LLM_URL/_KEY/_MODEL` env drive a zero-dependency OpenAI-compatible `/v1/chat/completions` call expecting `{"ok","reason"}`).

Without any of these they skip-allow loudly; crashes/timeouts report `ok:false` and the caller decides by `block`/`async`. The host `ctx` is deliberately NOT probed for model services — model calls cost tokens, so blind auto-dial is worse than an explicit config.

## Wake-up delivery (`async: rewake`, Stop/UserPromptSubmit deny)

1. Primary path: the agent seen on the session (`exec.agent`, same object the host's own session-controller/subagents use) gets `agent.followup(userMessage)` — next-turn + wakeDriver, the exact in-house mechanism.
2. Fallback: legacy `session` method probing (`injectMessage`/`appendMessage`/…).
3. Neither: warn + log only (never throws into the pipeline).

`rewake` fires only on explicit deny (`exit 2`, JSON `decision:deny`/`ok:false`); plain `exit 1` and timeouts are logged, never wake. Session identity is cached per tool call, so the first tool call in a session arms later session-event wakes.

## Hook scripts (portable install)

The repo ships ready-made scripts under `hooks/` (`guard.mjs`, `wait-flag.mjs`). They are written against portable paths only:

```powershell
# one-time setup: copy the scripts into your DSH home
Copy-Item <repo>\hooks\* $env:USERPROFILE\.dsh\hooks\
Copy-Item <repo>\examples\hooks.json $env:USERPROFILE\.dsh\hooks.json  # then adapt matchers
```

Reference them as `node ~/.dsh/hooks/guard.mjs`: the leading `~/` is expanded by the plugin on every platform (including Windows `cmd`), and `wait-flag.mjs` expands `~` in its own flag argument too. Never hard-code `C:/Users/...` in shared configs.

## Commands

- `/hooks` — list hooks, sources, warnings, recent runs.
- `/hooks-reload` — re-read all config sources; replaces the active hook list (no restart).

## Skill (progressive context loading)

`skill/SKILL.md` ships a compact usage reference (installs to `~/.dsh/skills/dsh-hook-plus/`). The skill catalog carries only `name` + one-line description; the full text loads on demand, so idle sessions pay ~1 line of context. It points back here for the complete spec.

## Development

```sh
npm run check   # syntax checks for all lib modules
npm test        # node:test suite (format, merge, match, exec, eval, wiring)
```

## License

MIT © 2026 jinxzzh. Inspired by [dsh-hooks-lite](https://github.com/xuedipiaofei/dsh-hooks-lite) (xuedipiaofei); format and implementation are original to this project.
