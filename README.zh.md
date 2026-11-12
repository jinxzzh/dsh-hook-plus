# dsh-hook-plus

[English](./README.md)

DeepSeek Harness 自研格式生命周期 hooks，对齐 Qoder Hooks 功能。一个 hook = 一事件 + 一动作，不收 `type:` 税。

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
```

## 格式

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是（自动带来源前缀 `user-1`/`proj-2`…） | 唯一；同文件重复丢弃并报错，跨文件后加载覆盖先加载 |
| `on` | 是 | 22 规范事件名（`SessionStart…ElicitationResult`），小写别名可进 |
| `run`/`call`/`ask`/`check` | 四选一 | shell 命令 / http(s) 地址 / 评判提示词 / 子 Agent 提示词 |
| `match` | 否 | 字符串速写（`Bash`、`Write\|Edit`、`*`、`mcp__.*`、`Bash(git *)`）或对象（`tool` 走匹配语法、`arg` 走 glob，其余键是 payload 路径：正则 / 布尔数字精确相等 / `{gt,gte,lt,lte,eq}`） |
| `timeout` | 否 | `500ms`/`30s`/`5m`，裸数字按**秒**；默认 run 30s / call 15s / ask 60s / check 120s，上限 10 分钟 |
| `async` | 否 | `sync`（接缝允许时可阻断）/ `background`（后台跑）/ `rewake`（后台跑，仅明确拒绝时唤醒模型） |
| `args` | 否 | 数组即 exec 形态（不过 shell，`${VAR}` 由插件展开）；没有就是 shell 形态 |
| `shell/env/headers/allowedEnvVars` | 否 | shell 指定；追加环境变量；http 请求头（`${ENV}` 插值，受白名单约束） |
| `model/tools/maxTurns` | 否 | ask/check 的模型、子 Agent 工具白名单、1–200 轮 |
| `msg/rewakeMessage/rewakeSummary` | 否 | spinner 文案；唤醒备注（摘要 ≤300 字） |
| `cwd/stdin/block/enabled/once` | 否 | `session` = 会话目录；`stdin:false` 不喂 payload；`block:false` 只观察；`once` 成功一次即消费 |

工具名忽略大小写（`Bash` 能命中 DSH 的 `bash`），文件路径保持大小写敏感。超时 fail-closed：卡死的拦截器按拒绝处理。裸数字超时按秒。

## 配置来源（从低到高，同名后赢）

1. `$DSH_HOME/hooks.json`（用户级）
2. 内联 `config.hooks`（profile patch）
3. `${cwd}/.dsh/hooks.json`（项目共享）
4. `${cwd}/.dsh/hooks.local.json`（本机项目）

缺文件静默跳过，坏 JSON 只报错不抛。`/hooks` 看来源、覆盖关系、警告和最近运行，`/hooks-reload` 重读全部。

## 事件 → DSH 接缝

| Hook 事件 | 接缝 | 能否阻断 |
|---|---|---|
| `PreToolUse` | `tools/pre-execute` | 能（`exit 2` / JSON `decision:deny` / `ok:false` / `continue:false`；`updatedInput` 改写参数） |
| `PostToolUse` / `PostToolUseFailure`（按 `result.isError` 区分） | `tools/post-execute` | 否；sync 可设 `updatedOutput` / `additionalContext` |
| `Stop` | `session/event` 的 `turn/end` | 广播：拒绝转为唤醒备注 |
| `UserPromptSubmit` | `session/event` 的 `user/message` | 仅观察（广播拦不住）；拒绝转为唤醒备注；消息文本镜像到 `prompt`，字符串匹配能命中 |
| 其余（Session*/Permission*/Subagent*/Compact/Notification…） | `session/event` 收规范类型直通 | 有宿主发出即触发；仅明确拒绝才唤醒 |

`step/end`、`session/title` 无 Qoder 对应，配置校验直接拒绝（请写 `Stop`），未知会话类型警告一次并跳过。

## Hook 应答（扁平，无包装）

脚本（`exit 0` + stdout JSON）与 `call` 回包都用顶层字段：`decision: allow|deny|ask`、`ok`、`continue`、`reason`、`updatedInput`、`updatedOutput`、`additionalContext`、`action`、`content`、`retry`、`clearContext`、`worktreePath`、`systemMessage`。`exit 2` = 拒绝（`stderr` 当原因）；其他非零退出无 JSON = 错误（只记日志，不唤醒）。`ask` 因无审批 UI，按拒绝处理并标注 `[ask]`。

每次拒绝、改写（`updatedInput`）、注入（`additionalContext`）、唤醒都带结构化块，模型看得见。pre 的备注会暂存、post 时刷入 `result.content`（即使零个 post hook 也会刷），改写不会静默：

```text
[Hook dsh-hook-plus] id=guard | on=PreToolUse | action=run | tool=bash | result=blocked(exit 2) | 66ms
Reason: no rm
```

## ask / check

`ask`（自动追加事件 JSON）、`check`（`$ARGUMENTS` 没写也自动追加）走注入的 `evaluator`：`config.evaluator` 函数优先；否则 `config.llm`（`baseUrl/apiKey/model`）或 `DSH_HOOK_LLM_URL/_KEY/_MODEL` 环境变量驱动零依赖的 OpenAI 兼容调用，要求回 `{"ok","reason"}`。

都没配则跳过放行并警告；崩溃/超时报 `ok:false`，拦不拦由 `block`/`async` 裁决。宿主 `ctx` 上的模型服务**故意不探测**——调模型烧 token，盲打未知接口比 loud skip 更糟，请显式配置。

## 叫醒投递（`rewake`、Stop/UserPromptSubmit 拒绝）

1. 主路径：用会话上见过的 agent 调 `agent.followup(用户消息）`——和宿主 session-controller/子智能体同一条 next-turn + wakeDriver 通道。
2. 兜底：旧 `session` 方法探测（`injectMessage`/`appendMessage`/…）。
3. 都没有：警告 + 只记日志，绝不抛进管线。

`rewake` 仅明确拒绝才叫醒（`exit 2`、JSON `decision:deny`/`ok:false`）；普通 `exit 1` 和超时只记日志。agent 按会话缓存，首个工具调用即建档，后续 session 事件可用。

## Hook 脚本（可移植安装）

仓库 `hooks/` 下自带开箱脚本（`guard.mjs`、`wait-flag.mjs`），只用可移植路径：

```powershell
# 一次性安装：拷到你的 DSH home
Copy-Item <repo>\hooks\* $env:USERPROFILE\.dsh\hooks\
Copy-Item <repo>\examples\hooks.json $env:USERPROFILE\.dsh\hooks.json  # 再按需改 match
```

引用一律写 `node ~/.dsh/hooks/guard.mjs`：行首 `~/` 由插件在所有平台展开（含 Windows `cmd`），`wait-flag.mjs` 自己的 flag 参数也展开 `~`。共享配置里不要写死 `C:/Users/...`。

## 开发

```sh
npm run check   # 全部 lib 模块语法检查
npm test        # node:test 套件（格式、合并、匹配、执行、评估、接线）
```

## License

MIT © 2026 jinxzzh。灵感源于 [dsh-hooks-lite](https://github.com/xuedipiaofei/dsh-hooks-lite)（xuedipiaofei），格式与实现均为本项目原创。
