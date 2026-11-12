# dsh-hook-plus

[English](./README_EN.md)

DeepSeek Harness 生命周期 hooks 插件：一个 hook = 一事件 + 一动作。能拦危险命令、改写工具参数与结果、监听会话事件、长任务结束时叫醒模型——不需要轮询等待。

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

## 安装

```powershell
# 1. 装插件（二选一）
dsh plugin --profile desktop add github:jinxzzh/dsh-hook-plus
# 或者本地目录安装（开发版）：
# dsh plugin --profile desktop add D:\path\to\dsh-hook-plus

# 2. 拷开箱脚本和示例配置到你的 DSH home（只需一次）
Copy-Item <repo>\hooks\* $env:USERPROFILE\.dsh\hooks\
Copy-Item <repo>\examples\hooks.json $env:USERPROFILE\.dsh\hooks.json
# Linux/macOS: cp <repo>/hooks/* ~/.dsh/hooks/ && cp <repo>/examples/hooks.json ~/.dsh/hooks.json

# 3. 重启 DSH（新插件需重启加载；之后改配置只用 /hooks-reload）
# 4. 任意会话执行 /hooks，看到 4 个 hook 且无 Warnings 即成功
```

引用一律写 `node ~/.dsh/hooks/guard.mjs`：行首 `~/` 由插件在所有平台展开（含 Windows `cmd`），`wait-flag.mjs` 自己的 flag 参数也展开 `~`。共享配置里不要写死绝对路径。

## 应用方法

### 1. 危险命令拦截

模型执行工具前先过一遍安检，命中直接拒绝并告诉模型原因：

```yaml
- id: guard-rm
  on: PreToolUse
  match: Bash(rm *)
  run: node ~/.dsh/hooks/guard.mjs
```

自带 `guard.mjs` 会拒绝：`rm -rf /|~|盘符根`、fork 炸弹、裸盘写入（`dd of=/dev/`）、`mkfs`、系统目录删除、格盘。只在匹配的命令上触发（`match` 先窄过滤），正常命令零打扰。

### 2. 写后自动检查

文件写入/编辑成功后自动跑 lint、格式化或单测，失败只记日志不挡流程：

```yaml
- id: lint
  on: PostToolUse
  match: { tool: Write|Edit, arg: "*.ts" }
  run: npx eslint --fix
  async: background
```

### 3. 长任务完成通知（不用 sleep 轮询）

`async: rewake` 的 hook 在后台等程序结束，结束那一刻叫醒模型并附上结果：

```yaml
- id: wait-long-job
  on: PostToolUse
  match: { tool: pwsh, arg: "*train.py*" }
  async: rewake
  timeout: 10m
  rewakeSummary: 训练任务已结束
  run: node ~/.dsh/hooks/wait-flag.mjs ~/.dsh/hooks/done.flag
```

启动任务时顺手埋个结束标记（程序正常/异常退出都会写）：

```powershell
python train.py; "EXIT:$LASTEXITCODE" | Out-File ~/.dsh/hooks/done.flag
```

`wait-flag.mjs` 用 `fs.watch` 事件驱动等待（不是轮询），flag 出现即 `exit 2` 唤醒，模型直接看到程序输出摘要。单次等待上限 10 分钟，超长任务可分段埋多个 flag 续接。默认 `enabled: false`，用时打开并按需改 `match`。

### 4. 失败自动记账

工具失败后把现场追加到日志文件，回头统一复盘：

```yaml
- id: log-failures
  on: PostToolUseFailure
  match: Bash
  async: background
  run: node ~/.dsh/hooks/log-fail.mjs >> ~/.dsh/hooks/failures.log
```

### 5. AI 评审门禁

拿一次独立的模型调用做判断，返回 `{ok, reason}`；`ok:false` 即阻断：

```yaml
- id: prod-guard
  on: PreToolUse
  match: Bash(kubectl delete *)
  ask: 判断这条命令在生产环境是否安全，不安全返回 ok=false 并给出 reason
  model: haiku
```

### 6. 子 Agent 实地核查

需要读文件、跑检查才能判定的场景，起一个子 Agent 去看现场，必须调 `StructuredOutput` 返回 `{ok, reason}`：

```yaml
- id: review-diff
  on: PreToolUse
  match: Bash(git push *)
  check: 审查当前工作区未提交变更是否可发布：$ARGUMENTS
  tools: [Read, Grep]
  maxTurns: 20
```

### 7. 回调外部服务

把事件 JSON POST 给你的服务，由服务决定 `allow/deny` 或记录归档：

```yaml
- id: audit
  on: PostToolUse
  async: background
  call: https://example.com/hook
```

`ask`/`check` 需配置模型通道：`config.evaluator` 函数优先，否则 `config.llm: {baseUrl, apiKey?, model}` 或 `DSH_HOOK_LLM_URL/_KEY/_MODEL` 环境变量（OpenAI 兼容接口）。都没配则跳过放行并警告。

## 格式

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是（自动带来源前缀 `user-1`/`proj-2`…） | 唯一；同文件重复丢弃并报错，跨文件后加载覆盖先加载 |
| `on` | 是 | 22 规范事件名（`SessionStart…ElicitationResult`），常用小写别名可进（`pre-tool`、`user/message` 等） |
| `run`/`call`/`ask`/`check` | 四选一 | shell 命令 / http(s) 地址 / 评判提示词 / 子 Agent 提示词 |
| `match` | 否 | 字符串速写（`Bash`、`Write\|Edit`、`*`、`mcp__.*`、`Bash(git *)`）或对象（`tool` 走匹配语法、`arg` 走 glob，其余键是 payload 路径：正则 / 布尔数字精确相等 / `{gt,gte,lt,lte,eq}`） |
| `timeout` | 否 | `500ms`/`30s`/`5m`，裸数字按**秒**；默认 run 30s / call 15s / ask 60s / check 120s，上限 10 分钟 |
| `async` | 否 | `sync`（接缝允许时可阻断）/ `background`（后台跑）/ `rewake`（后台跑，仅明确拒绝时唤醒模型） |
| `args` | 否 | 数组即 exec 形态（不过 shell，`${VAR}` 由插件展开）；没有就是 shell 形态 |
| `shell/env/headers/allowedEnvVars` | 否 | shell 指定；追加环境变量；http 请求头（`${ENV}` 插值，受白名单约束） |
| `model/tools/maxTurns` | 否 | ask/check 的模型、子 Agent 工具白名单、1–200 轮 |
| `msg/rewakeMessage/rewakeSummary` | 否 | spinner 文案；唤醒备注（摘要 ≤300 字） |
| `cwd/stdin/block/enabled/once` | 否 | `session` = 会话目录；`stdin:false` 不喂 payload；`block:false` 只观察；`once` 成功一次即消费 |

工具名忽略大小写（`Bash` 能命中 DSH 的 `bash`），文件路径保持大小写敏感。超时 fail-closed：卡死的拦截器按拒绝处理。

## 配置来源（从低到高，同名后赢）

1. `$DSH_HOME/hooks.json`（用户级）
2. 内联 `config.hooks`（profile patch）
3. `${cwd}/.dsh/hooks.json`（项目共享）
4. `${cwd}/.dsh/hooks.local.json`（本机项目）

缺文件静默跳过，坏 JSON 只报错不抛。`/hooks` 看来源、覆盖关系、警告和最近运行，`/hooks-reload` 重读全部（改配置不用重启）。

## 事件 → DSH 接缝

| Hook 事件 | 接缝 | 能否阻断 |
|---|---|---|
| `PreToolUse` | `tools/pre-execute` | 能（`exit 2` / JSON `decision:deny` / `ok:false` / `continue:false`；`updatedInput` 改写参数） |
| `PostToolUse` / `PostToolUseFailure`（按 `result.isError` 区分） | `tools/post-execute` | 否；sync 可设 `updatedOutput` / `additionalContext` |
| `Stop` | `session/event` 的 `turn/end` | 广播：拒绝转为唤醒备注 |
| `UserPromptSubmit` | `session/event` 的 `user/message` | 仅观察（广播拦不住）；拒绝转为唤醒备注；消息文本镜像到 `prompt`，字符串匹配能命中 |
| 其余（Session*/Permission*/Subagent*/Compact/Notification…） | `session/event` 收规范类型直通 | 有宿主发出即触发；仅明确拒绝才唤醒 |

`step/end`、`session/title` 不映射任何事件，配置校验直接拒绝（请写 `Stop`），未知会话类型警告一次并跳过。

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

## 开发

```sh
npm run check   # 全部 lib 模块语法检查
npm test        # node:test 套件（格式、合并、匹配、执行、评估、接线）
```

## License

MIT © 2026 jinxzzh
