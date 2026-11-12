# dsh-hook-plus

[中文](./README.md)

Self-owned lifecycle hooks for DeepSeek Harness. One hook = one event + one action. Block dangerous commands, rewrite tool input/output, react to session events, and wake the model when long jobs finish — no polling loops.

```yaml
- id: guard-rm
  on: PreToolUse
  match: Bash(rm *)
  run: node ~/.dsh/hooks/guard.mjs
- id: lint
  on: PostToolUse
  match: { tool: Write|Edit, arg: "*.ts" }
  run: npx eslint --fix
  timeout: 30s
  async: background
```

## Install

```powershell
# 1. Install the plugin (pick one)
dsh plugin --profile desktop add github:jinxzzh/dsh-hook-plus
# or from a local checkout (dev):
# dsh plugin --profile desktop add D:\path\to\dsh-hook-plus

# 2. Copy the ready-made scripts and the example config into your DSH home (once)
Copy-Item <repo>\hooks\* $env:USERPROFILE\.dsh\hooks\
Copy-Item <repo>\examples\hooks.json $env:USERPROFILE\.dsh\hooks.json
# Linux/macOS: cp <repo>/hooks/* ~/.dsh/hooks/ && cp <repo>/examples/hooks.json ~/.dsh/hooks.json

# 3. Restart DSH (new plugins load at startup; later config edits only need /hooks-reload)
# 4. Run /hooks in any session: 4 hooks, no Warnings means success
```

Always reference scripts as `node ~/.dsh/hooks/guard.mjs`: the leading `~/` is expanded by the plugin on every platform (including Windows `cmd`), and `wait-flag.mjs` expands `~` in its own flag argument too. Never hard-code absolute paths in shared configs.

## Recipes

### 1. Guard destructive commands

Screen model tool calls before they run; deny with a reason the model can read:

```yaml
- id: guard-rm
  on: PreToolUse
  match: Bash(rm *)
  run: node ~/.dsh/hooks/guard.mjs
```

Bundled `guard.mjs` refuses: `rm -rf /|~|drive roots`, fork bombs, raw disk writes (`dd of=/dev/`), `mkfs`, recursive deletes under system directories, volume formats. Narrow `match` filters first, so innocent commands pay nothing.

### 2. Auto-check after writes

Lint, format, or test after every successful file write/edit; failures only log, never block:

```yaml
- id: lint
  on: PostToolUse
  match: { tool: Write|Edit, arg: "*.ts" }
  run: npx eslint --fix
  async: background
```

### 3. Notify when a long job finishes (no sleep polling)

A `rewake` hook waits in the background and wakes the model with the result the moment the program ends:

```yaml
- id: wait-long-job
  on: PostToolUse
  match: { tool: pwsh, arg: "*train.py*" }
  async: rewake
  timeout: 10m
  rewakeSummary: Training job finished
  run: node ~/.dsh/hooks/wait-flag.mjs ~/.dsh/hooks/done.flag
```

Drop a flag file when the program exits (runs on success and failure alike):

```powershell
python train.py; "EXIT:$LASTEXITCODE" | Out-File ~/.dsh/hooks/done.flag
```

`wait-flag.mjs` waits with event-driven `fs.watch` (not polling); on sight it exits 2 and the model wakes up to the summary. One wait caps at 10 minutes — chain multiple flags for longer jobs. Ships `enabled: false`; enable and adapt `match` when you need it.

### 4. Log failures automatically

Append each failed tool call to a log for later review:

```yaml
- id: log-failures
  on: PostToolUseFailure
  match: Bash
  async: background
  run: node ~/.dsh/hooks/log-fail.mjs >> ~/.dsh/hooks/failures.log
```

### 5. AI approval gate

One isolated model call judges; `{ok: false}` blocks:

```yaml
- id: prod-guard
  on: PreToolUse
  match: Bash(kubectl delete *)
  ask: Decide whether this command is safe for production; return ok=false with a reason when it is not
  model: haiku
```

### 6. Sub-agent field check

For verdicts that need reading files or running checks, spawn a sub-agent that must return `{ok, reason}` via `StructuredOutput`:

```yaml
- id: review-diff
  on: PreToolUse
  match: Bash(git push *)
  check: Review uncommitted workspace changes for release readiness: $ARGUMENTS
  tools: [Read, Grep]
  maxTurns: 20
```

### 7. Call back into an external service

POST the event JSON to your service for allow/deny decisions or archiving:

```yaml
- id: audit
  on: PostToolUse
  async: background
  call: https://example.com/hook
```

`ask`/`check` need a model channel: a `config.evaluator` function wins; otherwise `config.llm: {baseUrl, apiKey?, model}` or the `DSH_HOOK_LLM_URL/_KEY/_MODEL` env vars drive a zero-dependency OpenAI-compatible call expecting `{"ok","reason"}`. With neither configured they skip-allow loudly.

## Format

| Field | Required | Meaning |
|---|---|---|
| `id` | yes (auto-prefixed `user-1`/`proj-2`…) | unique; same-file duplicates dropped with an error, later sources win across files |
| `on` | yes | one of 22 canonical events (`SessionStart…ElicitationResult`); common lowercase aliases accepted |
| `run`/`call`/`ask`/`check` | exactly one | shell command / http(s) URL / judge prompt / sub-agent prompt |
| `match` | no | string shorthand (`Bash`, `Write\|Edit`, `*`, `mcp__.*`, `Bash(git *)`) or object (`tool` = matcher syntax, `arg` = glob, other keys = payload paths: regex / boolean+number exact / `{gt,gte,lt,lte,eq}`) |
| `timeout` | no | `500ms`/`30s`/`5m`; bare numbers are **seconds**; defaults run 30s / call 15s / ask 60s / check 120s, cap 10m |
| `async` | no | `sync` (may block where the seam allows) / `background` (fire-and-forget) / `rewake` (background, wakes the model only on explicit deny) |
| `args` | no | array = exec form (no shell; `${VAR}` expanded by the plugin); absent = shell form |
| `shell/env/headers/allowedEnvVars` | no | shell override; extra env; http headers (`${ENV}` interpolation, allowlist-gated) |
| `model/tools/maxTurns` | no | ask/check model, sub-agent tool whitelist, 1–200 turns |
| `msg/rewakeMessage/rewakeSummary` | no | spinner text; wake-up note (summary ≤300 chars) |
| `cwd/stdin/block/enabled/once` | no | `session` = session cwd; `stdin:false` skips payload; `block:false` observes only; `once` consumes after first success |

Tool names match case-insensitively (`Bash` hits DSH's `bash`); file paths stay case-sensitive. Timeouts are fail-closed: a hung interceptor denies.

## Config sources (low → high precedence, later duplicate id wins)

1. `$DSH_HOME/hooks.json` (user)
2. inline `config.hooks` (profile patch)
3. `${cwd}/.dsh/hooks.json` (shared project)
4. `${cwd}/.dsh/hooks.local.json` (project-local)

Missing files are skipped; bad JSON errors without throwing. `/hooks` shows sources, overrides, warnings, recent runs; `/hooks-reload` re-reads everything (no restart needed for config edits).

## Events → DSH seams

| Hook event | Seam | Can block? |
|---|---|---|
| `PreToolUse` | `tools/pre-execute` | yes (`exit 2` / JSON `decision:deny` / `ok:false` / `continue:false`; `updatedInput` rewrites args) |
| `PostToolUse` / `PostToolUseFailure` (split by `result.isError`) | `tools/post-execute` | no; sync hooks may set `updatedOutput` / `additionalContext` |
| `Stop` | `session/event` `turn/end` | broadcast: deny becomes a wake-up note |
| `UserPromptSubmit` | `session/event` `user/message` | observe-only (broadcast cannot block); deny becomes a wake-up note; message text is mirrored to `prompt` |
| Others (Session*/Permission*/Subagent*/Compact/Notification…) | canonical types pass straight through `session/event` | fire whenever a host emits them; wake only on explicit deny |

`step/end` and `session/title` map to no event and are rejected at config validation (write `Stop`); unknown session types warn once and skip.

## Hook answers (flat, no wrapper)

Scripts (`exit 0` + stdout JSON) and `call` responses use top-level fields: `decision: allow|deny|ask`, `ok`, `continue`, `reason`, `updatedInput`, `updatedOutput`, `additionalContext`, `action`, `content`, `retry`, `clearContext`, `worktreePath`, `systemMessage`. `exit 2` = deny (`stderr` is the reason); other nonzero exits without JSON = error (logged only, never wakes). `ask` has no approval UI, so it blocks as `[ask]`.

Every denial, rewrite, injection, and wake carries a structured block the MODEL sees. Pre-execute notes are stashed and flushed into `result.content` at post-execute (even with zero post hooks), so rewrites are never silent:

```text
[Hook dsh-hook-plus] id=guard | on=PreToolUse | action=run | tool=bash | result=blocked(exit 2) | 66ms
Reason: no rm
```

## ask / check

`ask` (event JSON appended) and `check` (`$ARGUMENTS` auto-appended when missing) dispatch to the injected `evaluator`: `config.evaluator` first; else `config.llm` (`baseUrl/apiKey/model`) or the `DSH_HOOK_LLM_URL/_KEY/_MODEL` env vars drive a zero-dependency OpenAI-compatible call expecting `{"ok","reason"}`.

With neither configured they skip-allow loudly; crashes/timeouts report `ok:false`, and the caller decides by `block`/`async`. Host `ctx` model services are deliberately NOT probed — blind-dialing burns tokens; configure explicitly.

## Wake delivery (`rewake`, Stop/UserPromptSubmit denies)

1. Primary path: `agent.followup(userMessage)` on a session-seen agent — the same next-turn + wakeDriver channel as the host session-controller and subagents.
2. Fallback: legacy `session` method probing (`injectMessage`/`appendMessage`/…).
3. Neither: warn + log only, never throws into the pipeline.

`rewake` wakes only on explicit deny (`exit 2`, JSON `decision:deny`/`ok:false`); plain `exit 1` and timeouts only log. The agent is cached per session (first tool call registers it) for later session events.

## Development

```sh
npm run check   # syntax checks for all lib modules
npm test        # node:test suite (format, merge, match, exec, eval, wiring)
```

## License

MIT © 2026 jinxzzh
