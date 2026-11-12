---
name: dsh-hook-plus
description: DSH lifecycle hooks: guard destructive commands, rewrite tool input/output, react to session events, wake the model when long jobs finish. Use when the user mentions hooks, auto-lint, command guardrails, run-completion callbacks, or "notify me when done".
---

# dsh-hook-plus (progressive reference)

One hook = one event + one action. No `type:` field — the action key implies it.

## Minimal configs (copy-paste)

Block a dangerous command:

```yaml
- id: guard-rm
  on: PreToolUse
  match: Bash(rm *)
  run: node ~/.dsh/hooks/guard.mjs
```

Rewrite tool input + inject context:

```yaml
- id: lint-note
  on: PostToolUse
  match: { tool: Write|Edit, arg: "*.ts" }
  run: npm run lint -- --quiet
  async: background
```

Wake me when a long job finishes (no polling):

```yaml
- id: wait-long-job
  on: PostToolUse
  match: { tool: pwsh, arg: "*train.py*" }
  async: rewake
  timeout: 10m
  run: node ~/.dsh/hooks/wait-flag.mjs ~/.dsh/hooks/done.flag
# launch pattern: <program> ; echo DONE > ~/.dsh/hooks/done.flag
```

## Action keys (exactly one per hook)

| key | runs | use |
|---|---|---|
| `run` | shell command (stdin = event JSON) | scripts, lint, guards |
| `call` | HTTP POST event JSON | callbacks to services |
| `ask` | single model judgement `{ok,reason}` | policy decisions |
| `check` | sub-agent review (`$ARGUMENTS` = event JSON) | state inspection |

## Events (canonical, 22)

`PreToolUse` (can block/deny, supports `updatedInput`), `PostToolUse` / `PostToolUseFailure` (supports `updatedOutput`/`additionalContext`), `Stop`, `UserPromptSubmit`, plus `SessionStart/End`, `PermissionRequest/Denied`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `Notification`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate/Remove`, `Elicitation(Result)`, `StopFailure`. Wired DSH seams today: pre/post tool, `Stop` (turn/end), `UserPromptSubmit` (observe-only).

## Filters & modifiers

- `match: "Bash"` exact, `"Write|Edit"` multi, `"*"` all, `"mcp__.*"` regex, `"Bash(git *)"` tool+arg-glob; or object `{tool, arg(glob), <payload.path>(regex|exact|{gt,…})}`. Tool names are case-insensitive.
- `timeout`: `500ms/30s/5m` (bare = seconds; defaults run 30s, call 15s, ask 60s, check 120s, cap 10m; timeouts fail closed).
- `async`: `sync` / `background` / `rewake` (rewake wakes only on explicit deny). `once`, `enabled`, `block`, `env`, `cwd`, `args` (exec form), `model/tools/maxTurns` (ask/check).

## Files & commands

Config (low→high precedence): `$DSH_HOME/hooks.json` → inline `config.hooks` → `${cwd}/.dsh/hooks.json` → `${cwd}/.dsh/hooks.local.json`. Later duplicate id wins.
Ready-made scripts ship in the repo under `hooks/` (`guard.mjs`, `wait-flag.mjs`); install once via `Copy-Item <repo>\hooks\* $env:USERPROFILE\.dsh\hooks\` (or `cp <repo>/hooks/* ~/.dsh/hooks/`), then reference as `node ~/.dsh/hooks/guard.mjs` — the leading `~/` is expanded by the plugin on every platform. Never hard-code `C:/Users/...` in shared configs.
Commands: `/hooks` (list, warnings, recent runs), `/hooks-reload` (hot reload, no restart). Hook answers are flat JSON: `decision/ok/continue/reason/updatedInput/updatedOutput/additionalContext`.
Full spec: `README.md` in the plugin repo (Chinese by default; English version: `README_EN.md`).
