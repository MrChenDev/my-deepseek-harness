# 01 架构设计（DeepSeek Harness）

## 1. Cordis：底层插件框架（vendored）

`vendor/` 里是源码级 vendored 的 Cordis 生态（统一 rescope 为 `@deepseek-ai/*`）。五个核心概念：

1. **插件 = 一个实现 Service 的对象**：可以是带 `inject`/`apply(ctx)` 的函数，也可以是 `Service` 子类；生命周期由 Cordis 挂载到当前 context。
2. **Context 是服务的仓库**：服务认领稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），其它插件按 key 找服务，不 import 具体实现。
3. **用 `inject` 声明服务依赖**：依赖服务存在后插件才激活，加载顺序由服务需求表达，而非手工排序。
4. **Typed Events 通信**：服务通过 TS 声明合并定义事件名，用 `emit` / `waterfall` / `parallel` / `serial` 派发。
5. **注册即效应（reversible effects）**：提示段、工具 schema、适配器、监听器都通过 `ctx.effect()` / `ctx.on()` 安装，卸载/热重载时可预测地回滚。

### 四种派发模式

| 模式 | 是否 await | 顺序 | 有返回值？ |
|---|---|---|---|
| `emit` | 否 | 注册顺序 | 否 |
| `waterfall` | 否（链式） | 注册顺序 | 是 |
| `parallel` | 是 | 并行 | 否 |
| `serial` | 是 | 注册顺序 | 是 |

**Waterfall 语义（最重要）**：`ctx.waterfall` 是"中间件式"的。监听器拿到 `(...args, next)`，调用 `next()` 委托给下一个（可包装结果），不调用 `next()` 就短路。多个监听器通常协作修改共享对象然后委托；策略类监听器（如 `agent/pre-step` 拒绝、`agent/request-error` 决定重试）可以短路。新事件必须用 JSDoc `@mode` 声明派发模式，生成目录会校验声明与派发点一致。

## 2. Profile / Bundle：运行时组合

运行中的 `dsh` 是一个按序叠加的插件树：

- **profile**：Harness home（`$DSH_HOME/profiles/<name>`）里的命名组合，列出叠加的 bundles、安装的 out-of-tree 插件、用户的 `cordis.patch.yml`。`web` 和 `headless` 是自带模板。
- **bundle**：Cordis 配置行 + 代码的分发格式。`package.json` 的 `dsh` 字段声明：`dsh.profile`（profile 的 bundle 列表）、`dsh.bundle`（bundle 的 patch 文件）。
- 层序：`bundle 顺序 → profile cordis.patch.yml → home cordis.patch.yml → --patch overlay`。patch 按 row id 替换整行 config 或插入新行（**不做深合并**）。
- `dsh --profile web --dump-config` 可查看实际启动的插件树。

三层 bundle：
- `dsh-base`：每个 profile 的第一层——模型适配器、工具、持久化、沙箱与审批策略、settings/credentials、telemetry、核心 spawn/fork 子代理提供方。
- `dsh-web-app`：加浏览器应用（host + client）。
- `dsh-headless`：一次性 runner，无服务器。

## 3. 事件分类（扩展点决策表）

仓库事件分三个域，选错域是新手最常见的错误：

1. **Session 事件**（`session/event`）：追加进持久化日志的**不可变事实**，如 `turn/start`、`user/message`、`assistant/chunk`、`tool/call`、`tool/result`、`request/header`。需要跨重载存活的选这个。
2. **Agent 事件**（`agent/*`）：携带**活着的 Agent** 的实时信号——inbox、step、status、request、validation、continuation。观察/拦截进行中的工作选这个。
3. **能力事件**（`fs/*`、`tools/*`、`telemetry/*`）：把策略与适配器挂到能力缝上，不 import loop。

完整生产/消费矩阵见 `docs/event-producer-consumer.md`（带声明文件与行号）。

## 4. Scope（作用域）：每 Agent 的注册边界

`dsh-scope` 是低级原语：
- **scope key**：按对象身份比较的不透明键；惯例上**活着的 Agent 就是自己 scope 的 key**。
- **agent.ctx**：Agent 的 scoped context。通过它注册的工具/提示段/变量/限制，scope 可见且 scope 生命周期（一个事实同时决定两者）。
- **shadowing**：最近者胜——scoped 工具/段/变量遮蔽同名的 global 版本（per-agent persona、per-agent 工具变体的机制）。
- **restriction**：`tools.restrict()` 只过滤**继承的 global 集**（交集），scope 自己注册的不受影响——这正是子代理运行时把上报工具注册进子层仍能工作的原因。
- **scope chain**：父子链。注册视图**向下**继承（子看得到祖先，近者遮蔽远者）；事件准入**向上**扩展（标注祖先的监听器能收到后代 key 的事件）。
- **preset 的 standing mount**：preset 的插件实例只挂载一次，之后每个命名该 preset 的 Agent 通过 `bindScopeParent` 加入（作用域父化），因此 preset 是"一个组合"，不是每会话一份。

## 5. Session Log + Surface（事件源模型）

这是全系统最核心的不可变事实，也是"模型可见 ⟺ 已记录"的锚点：

- `Session` 是 append-only 的事件日志，事件类型由 merge-extensible 的 `SessionEventMap` 声明；每条 `SessionEvent = { type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`。
- `seq = log.length`（连续、从 0 开始），`data` 必须是 lossless JSON（BigInt/函数/symbol/undefined/负零/非有限数/循环/稀疏数组/Map/Set/Date 都会在 append 时被拒绝）。
- **surface**：三种消息产生型事件（`user/message`、`assistant/message`、`tool/result`）通过 `surfaceOp` 进入有序 surface；`deriveMessages()` 按 surface 投影出模型历史（缓存 + replaceGeneration 失效）。
- **surfaceOp** 只有两种：`'append'`（追加尾部）与 `{op:'replace', start, end}`（压缩用，替换一段并 shadow 旧节点）。
- **模型历史从日志推导**：`deriveMessages()` 是 `deriveEventMessage` 对 surface 的 fold；外部重建者（持久化、快照回放、查询）fold 同一函数，保证任何请求可从日志精确重建（有运行时 invariant 断言这一点）。
- 日志事件必须 `ignorable: true` 才允许被旧 reader 安全跳过；默认 unknown type 是"拒绝重建"。
- `request/header` 是下一个请求的完整快照（call config + system + tools），`foldRequestHeader` 折叠出当前生效 header；loop 每次构建请求前对比并记录 `initial/resume/change` 理由。

## 6. 能力缝（Capability Seam）：三角色模型

一个可替换能力 = **Service Definition（抽象类/注册表，认领 `ctx.<key>`）+ Service Provider（实现）+ Consumer（消费服务，通常是模型工具）**。只有完整三件套才叫 seam；单角色不算。

模板：
- `dsh-shell`（Definition）→ `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-*`（Providers）→ `dsh-tool-bash`（Consumer）。
- `dsh-subprocess`（Definition）→ `dsh-subprocess-local` / `dsh-subprocess-e2b` → shell/terminal/LSP 消费者。
- `dsh-fs` → `dsh-fs-local` / `dsh-fs-e2b` / `dsh-fs-sandbox` → `dsh-tool-fs`。
- `dsh-llm`（Definition + Consumer 合一）→ `dsh-llm-deepseek` / `dsh-llm-pi-ai`。
- `dsh-subagent`（Definition）→ spawn-in-process / fork / acp / claude-code / codex / dsh-sdk → `dsh-tool-subagent`。

能力缝的意义：换一个 provider 就换整个产品面。FS 和 subprocess 共享同一"执行世界"，把两者指向远端沙箱（E2B）就能把 Bash/PTY/LSP 一起搬过去。

## 7. 持久化缝

- 持久化不实现在 `dsh-session` 里：后端插件订阅 `session/event` 缓冲、在 `session/flush`（parallel，await 全部）时落盘。
- `SessionPersistence`（`ctx.sessionPersistence`）是抽象缝；`dsh-session-persistence-jsonl`（默认，每会话一个 `.jsonl.zstd` 文件）与 `dsh-session-persistence-sqlite`（opt-in，Schema 17，打包行 + zstd 压缩 + delta 编码 provenance）。
- `SessionHeader` 与事件日志分开：版本、cwd、血缘（parentSession/seedLength/delegationDepth/origin/agentPreset）属于存储元数据，不参与回放。
- `PersistenceCoordinator` 统一编排：写批量合并、prepared-session 缓存、torn-tail 恢复（JSONL 有 Zstd 帧级恢复 + 截断标记）、`session/flush` 屏障。
- 检查点策略（`dsh-session-checkpoint-policy`）：请求发给模型前、顶层工具可能产生外部副作用前、每个 pre-step 边界后，把已确认的事件落盘。

## 8. 类型与 RPC 层（Typert）

- **Typert** 是编译期类型图系统：generator 从 TS 类型程序（analyzer，2943 行）生成 `InvocationDescriptor` 清单与严格 codec；loader 发现 `./typert` 导出并验证 manifest；registry 在运行时注册 lookups（Host 对象 ↔ wire 身份）与 Remote 服务。
- `@Remote` / `@RemoteScope` 标注业务方法；`@deepseek-ai/dsh-api-gateway` 的 Host 侧 `ctx.typertGateway` 解析 descriptor → 校验参数 → 注入 lookup 身份 → 调用业务方法 → 校验结果；Client 侧 `ctx.remote` 挂载生成方法并通过 Connection 的 `/api` 调用。
- SDK 层（`packages/sdk`）是独立的 NDJSON JSON-RPC 2.0 协议：`protocol`（transport）、`server`（进程内运行时方法：session.prompt、session.status、session.event 推送、subagent.* 通知）、`client`（子进程客户端，EOF→SIGTERM→SIGKILL 级联销毁）。
- ACP（`packages/acp`）是自动化专用的 Agent Client Protocol 服务器（stdio JSON-RPC），面向可信编程客户端，不暴露 UI 交互。

## 9. 代码模式（Code Mode）

- `dsh-tools` 的 `mode: 'native' | 'code' | 'both'` 控制模型看到什么：`code` 只发保留的 `run_code` 工具 + 生成的 TS/Python SDK 提示段（`tools:sdk`），模型直接调其它原生工具会被 `UNKNOWN_TOOL`（带"应从 run_code 内调用"的提示）拒绝。
- `run_code` 通过 `ctx.codeRuntime`（worker-thread / python 子进程后端）执行模型写的程序，程序内的异步绑定把子调用送回工具注册表（带 parent token，`tool/code-dispatch` 记录子调用；`tools/code-dispatch-log` waterfall 可改写落盘副本）。
- 这是"给模型的工具面"与"实际执行面"的分离，安全相关谓词（collapse）由注册表与提示段共享同一个函数，防止旁路。

## 10. 工程约束（改代码前必读）

- **注册是效应**：所有贡献走 `ctx.effect()` / `ctx.on()`；注册返回 disposer。
- **开关判别**：closed union 用 `assertNever`；merge-extensible union 走文档化默认分支。
- **waterfall 监听器必须 `next()`**，否则短路。
- **模型可见 ⟺ 已记录**：新模型可见输入必须新增 session 事件并从日志渲染。
- **能力缝完整三件套**，缺角色不算完成。
- **无硬编码可调项**：部署相关选择必须是可校验的 Config 字段；`DEFAULT_*` 常量不算配置。
- **跨边界 id 用 Branded**（`SessionId`、`CallId`、`CommandId`…），不用裸 string。
- **同进程类型边界信任 TS**，只在校验/解析/队列/模型/工具 JSON/持久化/worker/进程/线边界做运行时校验。
- **测试分层**：unit → coverage gate（单文件 100%）→ 真实 API e2e → keyless snapshot（ACP/headless 转录）→ web 浏览器快照。
- **非平凡改动必须带 Agent Note**，且归档后的 notes 冻结。
- 文档：当前态散文一行一段、一个事实一个家、字预算门禁（verify-doc-budgets）；改代码同步改 README/JSDoc。
