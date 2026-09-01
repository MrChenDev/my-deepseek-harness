# 02 全量包地图（packages/，226 包）

> 用法：按组定位角色；每个包一行。需要更细时打开该包 `README.md` 与 `src/index.ts`。包名统一 `@deepseek-ai/dsh-<name>`。

## core/（8 包，产品 API 脊柱）

| 包 | 角色 |
|---|---|
| `agent` | `Agent` 接口、AgentRegistry（`ctx.agents`）、`agent/*` 事件词汇、initiator scope。零 loop 依赖，loop 可换 |
| `agent-loop` | **唯一具体 loop**：`ReactLoopAgent` 驱动 turn/step；AgentLoop 工厂（create/resume/configured agents）、`FactoryOwnership` 生命周期、并行工具调度 |
| `agent-default-model` | `ctx.agentDefaultModel` 部署默认 provider/model/effort 选择 |
| `agent-tool-presentation` | preset 携带的工具呈现行：native/code/both |
| `scope` | 作用域原语：`createScope`、scope chain、scoped dispatch、shadowing |
| `session` | 事件源会话：`Session` 类、`SessionStore`、surface、deriveMessages、fork |
| `system-prompt` | 系统提示组装：section/context/tools/variable 注册 + assemble waterfall + `{{var}}` 插值 |
| `tools` | 工具注册表 + 执行流水线（pre/guard/execute/post/result）+ 呈现模式 + Code Mode + JSON Schema |

## llm/（5 包）

| 包 | 角色 |
|---|---|
| `llm` | Service Definition + Consumer：Message/ContentBlock/StreamChunk 词汇、`LlmRuntime`（适配器注册、prepareCall、resolveModelInfo、stream 归一化）、BlockAssembler、retry policy |
| `llm-deepseek` | DeepSeek 官方适配器（Anthropic 兼容 wire：translate/serialize/sse/adapter） |
| `llm-pi-ai` | PI.AI 适配器 |
| `llm-retry` | `agent/request-error` 监听器：按 retry policy 自动重试 |
| `token-meter` | 不可变 token 用量投影：usage 折叠、surface 折叠、估计器、breakdown |

## session/（13 包，持久化与派生）

| 包 | 角色 |
|---|---|
| `session-checkpoint-policy` | 语义持久化策略：请求前/副作用前/pre-step 后落盘屏障 |
| `session-persistence` | 持久化缝 Definition：`SessionPersistence` + `PersistenceCoordinator`（批量写、缓存、恢复） |
| `session-persistence-jsonl` | 默认后端：每会话 `.jsonl.zstd`，packed chunk 行（-60%），torn-tail 恢复 |
| `session-persistence-sqlite` | opt-in SQLite 后端（Schema 17：打包行 + zstd + delta provenance） |
| `session-projection` | 投影驱动注册表（`ctx.sessionProjections`）：注册纯数学 unit，框架驱动 fold + 变更推送 |
| `session-projection-cache` | 持久化投影缓存（fail-soft、ver 不匹配即弃、日志领先） |
| `session-stats` | sessionStats 投影：turn/step 数、LLM/tool/ttft/decode 耗时折叠 |
| `session-telemetry` | telemetry Definition：`SessionTelemetrySink` + capture coordinator + sharing 披露 |
| `session-telemetry-otel` | OpenTelemetry 后端（OTLP/HTTP logs，live 或按 feedback 回放） |
| `session-title` | 日志化标题：fold、fallback、rename、单 provider 注册 |
| `session-title-llm` | 模型标题生成共享实现（framing、预算、取消、路由） |
| `session-title-first-prompt-llm` | 首个 prompt 摘要 cadence |
| `session-title-all-prompts-llm` | 每个新 human prompt 摘要 cadence |

## session-query/（4 包）

| 包 | 角色 |
|---|---|
| `session-query` | `ctx.sessionQuery` 抽象：list/read/filter/trace/title/search + 逻辑记录与 surface fold 校验 |
| `session-query-sqlite` | SQLite FTS 实现（searchSessions/searchEvents） |
| `session-log-export` | 会话日志导出（压缩等） |
| `tool-session-query` | 模型工具：跨会话检索/读取 |

## subagent/（11 包）

| 包 | 角色 |
|---|---|
| `subagent` | 缝 Definition：`SubagentRuntime`（命名 provider 注册表、start/startContinuable/followup/interrupt、descriptor、child-agent 策略、续接管理器） |
| `subagent-spawn-in-process` | 进程内子 Agent（spawn） |
| `subagent-fork-in-process` | 进程内 fork 子 Agent |
| `subagent-in-process-driver` | 进程内驱动桥 |
| `subagent-acp` | ACP 子代理 provider（调用外部 ACP 服务器） |
| `subagent-claude-code` | Claude Code 子代理 provider（CLI 包装） |
| `subagent-codex` | Codex 子代理 provider |
| `subagent-dsh-sdk` | DSH SDK 子代理 provider |
| `tool-subagent` | 模型工具 `subagent`（start/startContinuable/followup/report） |
| `tool-subagent-control` | 控制工具（interrupt/kill/list 等） |
| `tool-subagent-report` | 报告工具 |

## workflow/（4 包）

| 包 | 角色 |
|---|---|
| `workflow` | 缝 Definition：`WorkflowEngine` + workflow/* 事件 + WorkflowError（fatal 语义） |
| `workflow-worker-thread` | worker-thread 执行器（脚本隔离、资源上限、agent 调用编排） |
| `tool-workflow` | 模型工具 `workflow`（运行脚本） |
| `tool-ralph` | Ralph 循环工具：每轮一个新子会话、共享 workspace + bounded handoff |

## goal/（4 包）

| 包 | 角色 |
|---|---|
| `goal` | 同会话目标域：event-sourced 状态、compare-and-set 变更、`goal/change` 事件、投影 |
| `goal-round-driver` | goal-round 驱动：把一轮目标物化成一次 turn，轮次上限，activation 权限 |
| `tool-goal` | 模型工具：创建/编辑/查询当前目标 |
| `command-goal` | `/goal` 人类命令 |

## jobs/（3 包）

| 包 | 角色 |
|---|---|
| `jobs` | 后台任务缝 Definition：`JobRegistry`（start/get/read/kill/wait/onJobDone） |
| `jobs-local` | 进程内实现（按 owner 并发上限，快照式读取） |
| `tool-jobs` | 模型工具 `job_output` / `job_list` / `job_kill` + 完成通知 |

## schedule/（1 包）

| 包 | 角色 |
|---|---|
| `schedule` | 会话本地提醒：`schedule_create` 等三工具，日志为状态源，持久化屏障后才确认 |

## plan/（1 包）

| 包 | 角色 |
|---|---|
| `plan-mode` | Plan 模式：`plan/mode` 日志状态 + `exit_plan_mode` 工具 + 用户审查问题 + 提示段切换 |

## compaction/（4 包）

| 包 | 角色 |
|---|---|
| `compaction` | 缝 Definition：`CompactionEngine`（compactIfNeeded/compactNow/compactRegion），工具配对平衡 |
| `compaction-basic` | 默认后端：token 压力/保留策略 + LLM 摘要 + 重放感知 surface 替换 |
| `compaction-tool-result-pruner` | 结果裁剪策略 |
| `command-compact` | `/compact` 人类命令 |

## context/（6 包）

| 包 | 角色 |
|---|---|
| `agent-instructions` | AGENTS.md 兼容指令链：初始注入 + 文件变更后发现/替换/移除通知 |
| `file-reference` | `@file` 引用语法 + `ctx.fileReferences` 发现缝 |
| `file-reference-local` | 本地文件系统实现（bounded fuzzy index） |
| `session-reference` | 跨会话引用：候选发现 + 只读快照上下文（`@[label](dsh-session:...)`） |
| `time-context` | 当前时区时间上下文（快照式） |
| `tmux-context` | tmux 位置上下文 |

## fs/（7 包）

| 包 | 角色 |
|---|---|
| `fs` | 缝 Definition：文件系统服务 + `fs/*` 事件 |
| `fs-local` | 本地实现 |
| `fs-sandbox` | 沙箱围栏实现 |
| `fs-observation-policy` | 观测策略（哪些路径变化可进上下文） |
| `tool-fs` | `read/write/edit/stat/list` 工具族 |
| `tool-fs-search` | 搜索工具（grep/find 风格） |
| `tool-str-replace-editor` | 字符串替换编辑器 |

## shell/（10 包）

| 包 | 角色 |
|---|---|
| `shell` | 缝 Definition：`ShellExecutor` 请求/spec 拆分模板 |
| `bash-local` / `bash-sandbox` | bash 执行器（本地/沙箱） |
| `pwsh-local` / `pwsh-sandbox` | PowerShell 执行器（win32） |
| `shell-env` | shell 环境解析 |
| `tool-bash` / `tool-bash-persistent` | bash 工具（一次性/持久） |
| `tool-pwsh` / `tool-pwsh-persistent` | pwsh 工具 |

## subprocess/（2 包）

| 包 | 角色 |
|---|---|
| `subprocess` | 缝 Definition：spawn/terminal/resolveExecutable/collect 输出契约 |
| `subprocess-local` | 本地实现：detached 进程树、taskkill/SIGTERM 级联、凭据清洗、offset 读取 |

## terminal/（3 包）

| 包 | 角色 |
|---|---|
| `terminal` | 持久 PTY 缝：`ctx.terminals` owner-scoped 会话注册表 |
| `terminal-bash` | PTY 后端（bash/pwsh 方言、readiness、sandboxPolicy） |
| `tool-terminal` | 六工具：open/send/read/signal/close/list |

## sandbox/（4 包）

| 包 | 角色 |
|---|---|
| `sandbox` | 缝 Definition：`SandboxPolicy`、confine 包装、escalation（升级审批） |
| `sandbox-local` | Landlock 本地后端（走 native/landlock-run） |
| `sandbox-policy` | 策略解析：mode 选择 + `sandbox/mode` 事件 + 审批升级 |
| `sandbox-windows-acl` | Windows ACL restricted-token 后端（win32 链） |

## e2b/（3 包）

| 包 | 角色 |
|---|---|
| `e2b` | E2B 共享沙箱生命周期（单 SDK handle） |
| `fs-e2b` | E2B 文件系统 provider |
| `subprocess-e2b` | E2B 子进程 provider |

## lsp/（3 包）

| 包 | 角色 |
|---|---|
| `lsp` | 缝 Definition：语义导航四操作 + provider 注册 |
| `lsp-stdio` | 通用 stdio 语言服务器后端 |
| `tool-lsp` | 模型工具 `lsp` |

## skill/（4 包）

| 包 | 角色 |
|---|---|
| `skill` | 缝 Definition：`SkillProvider` 注册表 + catalog/loader 工具 |
| `skill-filesystem` | 文件系统 provider |
| `skill-badge` | 技能徽章 |
| `tool-skill` | 模型工具：加载技能内容进上下文 |

## web/（6 包）

| 包 | 角色 |
|---|---|
| `web` | 缝 Definition：`WebRuntime`（fetch + search providers） |
| `web-fetch-http` | HTTP fetch provider（安全检索：redirect、字节上限、charset、二进制拒绝） |
| `web-search-deepseek` / `web-search-exa` / `web-search-perplexity` | 三个搜索 provider |
| `tool-web` | 模型工具 `web`（fetch/search 呈现） |

## storage/（4 包）

| 包 | 角色 |
|---|---|
| `storage` | 非会话数据存储枢纽：backend 注册表 + data-form 挂载 |
| `storage-domain` | domain data-form（`ctx.storage.domain`） |
| `storage-json` | JSON 文件后端 |
| `storage-sqlite` | SQLite 后端 |

## settings/ credentials/ identity/（5 包）

| 包 | 角色 |
|---|---|
| `settings` | 用户设置缝：namespace 注册、分层解析（默认→组合 base→用户文档）、热提交 |
| `settings-file` | 文件 provider（settings.yaml） |
| `credentials` | 凭据缝 Definition：`CredentialRef` 引用（绝不存值）+ 按操作解析 |
| `credentials-local` | env/.env provider |
| `identity` | 匿名身份：`$DSH_HOME/.anonymous-user-id` |

## interaction/（5 包）

| 包 | 角色 |
|---|---|
| `commands` | 人类命令注册表（`ctx.commands`）：/ 前缀、与模型工具分离 |
| `user-approval` | 审批缝：`ApprovalService` 一次性批准 |
| `user-questions` | 交互问题（ask-user 工具后端） |
| `tool-ask-user` | `ask_user` 工具 |
| `permission-presets` | 权限预设 |

## hooks/（3 包）

| 包 | 角色 |
|---|---|
| `hook-protocol` | 共享钩子协议库：matcher、命令执行/解码、输出合并、事件助手、detached runs |
| `hooks-claude-code` | Claude Code 钩子桥（PreToolUse/PostToolUse 等） |
| `hooks-codex` | Codex 钩子桥 |

## boot/ host/ api/（12 包）

| 包 | 角色 |
|---|---|
| `app-boot` | 共享启动胶水：.env、profile 解析、Loader 驱动、config 路径 |
| `cmdline` | 启动参数解析（快照式） |
| `apiproxy` | Host 侧 API 网关实现：`ctx.apiProxy` + fetch 载波 + 四象限 RPC 协议 |
| `directory-picker` | 目录选择缝（+ auto/browse/native 三实现） |
| `frontend-static` | SPA dist 服务 |
| `plugin-inventory` | 插件清单 |
| `webserver` | HTTP/upgrade 路由注册（exact > 最长前缀 > fallback） |
| `gateway` | Typert RPC 网关（Host `typertGateway` / Client `remote`） |
| `remotes` | API Remote 业务选择（api/remotes 分组） |

## client/（42 包，Web GUI 浏览器端，约 7.2 万行 TS）

分层：`web`（壳启动）→ `ui-renderer`（React 挂载）→ `modules`（浏览器端 client modules）→ `connection`（浏览器↔Host RPC/事件）→ `runtime`（共享客户端服务）→ `hmr`（开发热刷）→ `locale` → `ui-slots`/`ui-theme`/`ui-primitives`（基础）→ 30 个 `ui-*` 特性包（conversation、tool、subagent、goal、plan、jobs、workflow-run、trajectory、commands、skill、reference、settings-*、sidebar、workspace、model-selection、permission、user-questions、attachment、input-trigger、brand、layout、deliverables、message-feedback、directory-picker-browse…）。

每个 `ui-*` 通过 `ui-slots` 注册扩展槽；工具卡渲染由 `ui-tool` 按 keyed renderer 组合。

## extensions/（4 包，自修改）

| 包 | 角色 |
|---|---|
| `cordis-host-runner` / `cordis-client-runner` | host/client 侧 Cordis 运行器 |
| `tool-cordis` | 模型工具：查看/挂载自身插件（agent 修改自己运行时） |
| `ui-cordis` | 对应 UI 面板 |

## preset/（2 包）

| 包 | 角色 |
|---|---|
| `agent-presets` | preset 词汇、发现、standing mount（scope 父化）、`/preset` 相关命令、composition 读写 |
| `persona` | 人格段 |

## bundle/（3 包）

| 包 | 角色 |
|---|---|
| `base` | 每个 profile 第一层：cordis.patch.yml 插入所有基础行（win32 下 bash/pwsh 二选一） |
| `headless` | 一次性 runner 组合 |
| `web-app` | Web 应用组合（host + client 全链路） |

## mcp/（1 包）

| 包 | 角色 |
|---|---|
| `mcp-client` | MCP 客户端桥：连接外部 MCP server，工具以 `mcp__<server>__<raw>` 注册进 `ctx.tools` |

## code-runtime/（3 包）

| 包 | 角色 |
|---|---|
| `code-runtime` | 缝 Definition：`CodeRuntime.run(program, bindings)` |
| `code-runtime-worker-thread` | Node worker 后端（TypeScript，类型剥离，内存/时长上限，硬终止） |
| `code-runtime-python` | CPython 子进程后端（fd 3 JSON-lines 协议，host 视每个入帧为 hostile） |

## attachment/（2 包）

| 包 | 角色 |
|---|---|
| `attachment` | 持久附件缝：`ImageAttachmentRef` + 校验/批量提交 |
| `attachment-local` | content-addressed 本地对象存储（sha256，原子发布） |

## spill/（3 包）

| 包 | 角色 |
|---|---|
| `spill` | 超大工具结果落盘缝 Definition |
| `spill-local` | 会话私有文件实现 |
| `spill-policy` | post-execute 策略：超过 `maxInlineBytes` 溢出为 head/tail 预览 + locator |

## goal/、feedback/、guard/、todo/、workspace/、runtime-diagnostics/（7 包）

| 包 | 角色 |
|---|---|
| `feedback`（2） | 消息反馈域 + `/feedback` 命令 |
| `guard`（2） | `repeat-tool-reminder`（重复工具提醒）、`timeout-policy`（工具超时包装） |
| `todo`（1） | `todo_write` 工具（整表快照，last-write-wins） |
| `workspace`（1） | 工作区实体注册表（`ctx.workspaceRegistry`，持久顺序 + 会话索引） |
| `runtime-diagnostics/invariants`（1） | invariant 注册表（包拥有运行时断言，allow/blocklist 配置） |

## typert/（4 包）

| 包 | 角色 |
|---|---|
| `generator` | 类型图生成器：analyzer（TS 程序→模型）、emitter（→TS/JSON 产物）、tsdown 插件、cordis-catalog |
| `loader` | 发现 `./typert` 导出 + manifest 校验 + 注册 |
| `protocol` | 编译无关的协议类型：descriptor、lookup、Remote 结果 |
| `registry` | 运行时注册表：服务/对象注册、lookup 解析、上下文提供方 |

## sdk/（3 包）

| 包 | 角色 |
|---|---|
| `protocol` | NDJSON JSON-RPC 2.0 传输 + 方法/通知类型 |
| `server` | 运行时进程内方法（session.prompt 等）+ 事件推送 |
| `client` | 子进程客户端：spawn 运行时、订阅、销毁级联 |

## acp/（1 包）

| 包 | 角色 |
|---|---|
| `acp` | 自动化 ACP 服务器：newSession/prompt/cancel、图片 admission、审批桥 |

## util/（7 包）

| 包 | 角色 |
|---|---|
| `atomic-write` | 原子写 |
| `brand` | `Branded<T>` |
| `home-paths` | `$DSH_HOME` / `~/.dsh` 路径策略 |
| `launch-environment` | 启动环境快照 |
| `native-command` | 原生命令解析 |
| `output-retention` | `TextRetainer` 输出保留（spill 预览用） |
| `timeout` | 超时工具 |

## experimental/ examples/ test-support/（11 包）

| 包 | 角色 |
|---|---|
| `experimental/agent-team` | 实验性 Agent 团队缝（roster/task board/mailbox） |
| `experimental/tool-agent-team` | 团队工具 |
| `examples/acp-demo` / `agent-spine-demo` / `jsonrpc-demo` | 三个可运行 demo bundle（bin：agent-spine/ACP/JSON-RPC） |
| `test-support/acp-snapshot` | ACP 快照场景工厂 |
| `test-support/agent-loop-testkit` | loop 测试工具包 |
| `test-support/llm-mock-server` / `llm-replay` | LLM mock/回放 |
| `test-support/loader-smoke` | Loader 启动冒烟 |
| `test-support/client-runtime` | 浏览器客户端测试运行时 |

## 快速定位表（按你想做的事）

| 想做什么 | 去哪个包 |
|---|---|
| 改 agent 循环 | `core/agent-loop`（全仓唯一 loop 逻辑） |
| 加会话事件 | `core/session`（SessionEventMap 合并）+ 渲染函数 |
| 加工具 | 参考 `fs/tool-fs` 或 `web/tool-web` + `docs/cookbook/adding-a-tool.md` |
| 加模型 provider | `llm/llm-deepseek` 为模板 + `docs/cookbook/adding-an-llm-adapter.md` |
| 加能力缝 | 看 `shell` 三件套 + `docs/capability-seams.md` |
| 改持久化 | `session/session-persistence` + jsonl/sqlite 后端 |
| 改 UI | `packages/client/ui-*` + `client-modules` |
| 改启动组合 | `boot/app-boot` + `bundle/*` 的 cordis.patch.yml |
| 改 RPC | `api/gateway` + `typert/*` |
| 改钩子 | `hooks/hook-protocol` + hooks-claude-code / hooks-codex |
| 加包 | `docs/cookbook/adding-a-package.md` |
