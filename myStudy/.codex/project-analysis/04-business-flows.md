# 04 业务链路（端到端）

## 1. 启动链路

```text
dsh --profile web (apps/cli/src/bin.ts)
  → app-boot：loadEnv(.env) → resolveConfigPath(profile) → loadProfile（bundle 栈 + home patch）
  → 驱动 Cordis Loader 挂载 cordis.yml 插件树
     loader 条目 → include（!!js 表达式、disabled 判定、patch 应用）
     → 每个插件 apply(ctx)：
        注册 ctx 服务、systemPrompt 段、工具、监听器（全部是 effect）
  → 树稳定后：
    base bundle 行：llm-deepseek、tools、session-persistence-jsonl、sandbox-policy、settings、...
    web-app bundle 行：webserver、apiproxy、connection、frontend-static、agent-presets、...
    configured agents（agentLoop config）→ create/resume
```

关键：`verify-cordis-config` 门禁保证 bare 插件都在 manifest dependencies 里；`agent-loop` 的 `configuredAgentIdentities`（`ctx.provide`）允许 launcher 固定会话身份而不落 config key。

## 2. Agent 创建链路（agent-loop/src/index.ts）

```text
AgentLoop.create(id, options, meta)
  → SessionPreparation.create(sessions.prepare(id, {meta}))   // 构造但未入 store
  → prepare(ownerCtx, id, options, session, signal)
       // 先注册反向 teardown（machine cancel → scope.dispose → detachAgent/detachSession → untrack）
       // 融合三个 abort 源：caller signal / owner fiber unload / factory teardown
       → new ReactLoopAgent(loopCtx, id, options, session)
  → publish(source):
       sessions.enter(session) → agents.enter(agent, ownerCtx.agent)
       sessions.announce(session)  // session/created，可同步 veto
       agents.announce(agent)      // agent/created
       emitAgentEvent('agent/session-start', {source})   // 首个启动扩展点
  → 返回 AgentHandle {agent, dispose}
```

`createAgent`（异步，带 setup 回调）：`setup(agent.ctx)` 在发布前执行，`setupCommit?.commit()` 可延迟提交；失败 `prepared.dispose()` 全量回滚。`resume`：`persistence.prepare(id, fused)` → `Session.fromRestore`（校验+冻结）→ 同样 setupAndPublish，source='resume'。

## 3. 一次对话 turn 的完整链路

```text
客户端/CLI/ACP/SDK 投递 user message
  → agent.followup(message) → inbox.splice('next-turn', ..., [msg]) + wakeDriver
  → driver: turn/start
  → preStep: claim → systemPrompt.assemble（scope=agent）→ runtimeContext.project → agent/pre-step waterfall
  → 通过：user/message 落库 → step/start
  → buildRequest：
       request/header（初始/变更）+ request/context → llm.prepareCall（能力解析）→ 冻结请求
  → ctx.llm.stream(request)：
       llm/stream 事件（invariant 断言、token-meter、hooks 监听）
       adapterStream → deepseek adapter → provider HTTP/SSE → StreamChunk
       assistant/chunk 逐条落库 + BlockAssembler
  → assistant/message 落库（usage + sourceEventSeqs）
  → 若含 tool-call：executeToolCalls（§03-2）
       tool/call → pre-execute/guards → tools/execute(→ body) → post-execute → finalizeContent
       tool/result（sourceEventSeqs=[callSeq]）→ additionalContexts 进 next-step inbox
  → 还有 next-step 输入 → 再 step；没有 → agent/turn-stopping → turn/end
  → 持久化：session-checkpoint-policy 在请求前/副作用前/pre-step 后 flush
  → UI：session/event 推送 → client connection → 会话视图更新
```

## 4. 持久化写入链路

```text
session.append(type, data)
  → snapshotJsonValue（lossless 校验）
  → surfaceManager.validateNext（surface 契约校验）
  → log.push + session/event 同步派发（per-listener 隔离）
  → 后端监听器（PersistenceCoordinator）把事件进缓冲
  → ctx.sessions.flush(session)：parallel 派发 session/flush，等待全部后端
  → JSONL：批量写 zstd 帧；SQLite：事务写 scalar/packed 行
```

崩溃恢复：JSONL 用"帧级校验和 + 独立可解码"定位 torn tail → 截断到完好帧 + 恢复其中事件；SQLite 事务保证。`turn/end` 不强制 flush（checkpoint-policy 拥有逐请求屏障）。

## 5. Fork / Resume / 导出

- **Fork**：`sessions.fork(source, boundary?, childId?)` —— 校验边界是连续 seq、不能落在开 turn 内；子会话 seed = 源前缀事件，header 记 `parentSession` + `seedLength`。
- **Resume**：`agentLoop.resume` → persistence.prepare（加载+校验）→ `Session.fromRestore`（restore 模式：原地冻结不拷贝）→ 发布；`session/end-seed` 标记构造函数种子边界（durable firstLiveSeq 投影）。
- **导出/回放**：`session-log-export` + snapshot 测试；web 端 `session-projection` 的 history tail 页读取；ACP/headless 快照用记录 JSONL 重放并 diff 归一化 JSON-RPC。

## 6. 子代理链路

```text
模型调 subagent 工具（tool-subagent）
  → SubagentRuntime.start(request, parent agent)
  → 解析 provider（spawn-in-process / fork / acp / claude-code / codex / dsh-sdk）
  → provider 建立 child（childSessionMeta：delegationDepth+1、origin:'subagent'、agentPreset 继承）
  → child 发布：agent/created → child 独立 scope（不继承父 scope 可见性，只带 lineage 数据）
  → parent 的会话里出现 subagent/start（scope-filtered，以 parent 为 carrier）
  → child 跑自己的 turn；结果折叠成报告（descriptor/assistant-output fold）
  → subagent/end（stopReason: completed/aborted/error/...）→ tool/result 返回给模型
```

续接（continuable）：`startContinuable` 建立 durable child（持久化 id），`followup` 走 child 自己的 inbox（resident 直接投、absent 冷恢复），`interrupt` 只允许人类父地址或精确活祖先；descendant 发现读 live session store + persistence。

## 7. 工作流 / Ralph

- `tool-workflow`：模型给一段 JS 脚本字符串 → `WorkflowEngine.start` → worker-thread 执行（meta 校验、`agent()` 调用子代理、`parallel()/pipeline()` 组合子、资源上限、`phase()/log()` 生命周期事件）。
- 子代理失败 → 该 item 折叠成 `null`；fatal 错误（`WorkflowError.fatal`）→ 组合子 rethrow 杀死脚本。
- **Ralph**（`tool-ralph`）：前台"新 Agent"循环——每轮一个全新子会话（不继承父/前轮对话 seed），共享 workspace + bounded structured handoff（status/summary/evidence/next/blocker）跨轮传状态；round 计数器属该策略，不计普通 turn。

## 8. Goal（同会话目标）

```text
/goal 命令或 goal 工具 → GoalService.create/edit（goal/change 事件，compare-and-set revision）
  → 投影：applyGoalProjection（整目标视图）
  → goal-round-driver：激活（armed）后，把"继续完成目标"物化成一轮 goal-sourced turn
  → 轮次上限（maxGoalRounds）计 goal round 而非普通 turn
  → phase 流转：active → paused / blocked(code+explanation) / complete
  → activation 是 process-local 的，不持久化：resume/fork 需要用户再授权
```

## 9. 后台任务（jobs）

```text
模型调 job 相关工具或工具内部调 ctx.jobs.start(spec)
  → 校验 controller/spec/owner/输出上限 → producer.run() 一次
  → job_output / job_list / job_kill / job wait
  → 完成通知：tool-jobs 在 terminal 记录时向 agent 注入 notice（form:'notice'）
```

`jobs-local` 按 owner 并发上限（默认 10），无队列、无抢占；terminal `run_in_background` 复用该缝。

## 10. 提醒（schedule）

- `schedule_create/at/every`：写 `schedule/*` session 事件（状态源），**先 flush 再确认**（`persistence_uncertain` 兜底）。
- 计时器只是日志的投影：到点向会话注入 user/message（source relay/notice），唤醒 agent。
- 只装在未来 live root agents 上（监听 agent/created），runtime children 不装。

## 11. ACP 自动化链路

```text
外部客户端 → stdio NDJSON JSON-RPC → AcpServer（packages/acp）
  initialize → newSession（创建并拥有 Agent）→ prompt（图片 admission → user/message → turn）
  → assistant 输出逐块转为 ACP 消息块推送 → turn/end 映射为 stopReason
  → cancel / 一次性权限决策（经 ctx.approval）
  → 会话结束 dispose（agent + session 有序拆除）
```

ACP 是"自动化专用"：只带 prompt 文本/图片、committed 输出、取消、一次性审批；呈现与人类交互留在 UI 模块。

## 12. SDK（TypeScript/Python）链路

```text
HarnessClient（TS）或 deepseek_harness（Python）
  → 选择并 spawn 匹配的 runtime 子进程（bundled runtime）
  → NDJSON JSON-RPC over stdio：
       initialize（provider/model/maxTokens/cwd）
       session.prompt → 服务器建 Agent → 事件推送（session.event/session.status/subagent.*）
       subscribe() 过滤通知流
  → 关闭：EOF → SIGTERM → SIGKILL 级联，等待 quiescence
```

Python SDK 另有单文件 exe 打包（`scripts/build-exe-for-python-sdk*.ts`）与 `python/sdk-runtime` 的默认配置；两侧共享同一 runtime 协议。

## 13. Hooks（Claude Code / Codex 桥）

- `hook-protocol`：命令执行/解码、matcher、输出合并、事件助手、detached run。
- `hooks-claude-code`：把 harness 事件翻译成 Claude Code 钩子（PreToolUse/PostToolUse/Stop 等）并执行外部 CLI；`agent/pre-step`、`tools/pre-execute`、`tools/post-execute` 挂载钩子决策。
- `hooks-codex`：Codex 钩子桥（同一协议，不同 payload/环境规则/matcher 模式）。
- 钩子输出合并遵循"restrictive"语义（任一 deny 则 deny）。

## 14. Web GUI 链路

```text
浏览器（client/web 壳）→ connection（fetch POST /api/<method> + SSE 下行）
  → Host webserver → apiproxy（四象限 RPC：ClientRequest/ServerResponse/ServerRequest/ClientResponse）
  → Typert gateway（已生成 descriptor 的方法）或 API Proxy 业务方法
  → 业务服务（agents/sessions/goals/...）→ 响应 + session/event 推送
  → client connection 分帧 → runtime 服务 → ui-* 组件更新
```

关键设计：RPC 方法参数/返回类型只在 domain 接口签名里，`RpcMethodMap` 注册方法，其它位置用 `RequestPayload<K>`/`ResponseValue<K>` 派生；Zod 双层解析（envelope → 业务 payload）；所有 POST 必须 `application/json`（拒绝 415，防无预检的跨站副作用）。

## 15. MCP 外部工具

```text
cordis.yml 每 server 一个 dsh-mcp-client 实例
  → 连接 MCP server（stdio/HTTP）→ 发现工具列表
  → 以 mcp__<server>__<raw> 注册进 ctx.tools（schema 透传）
  → 模型调用 → tools 流水线 → mcp-client 转发 JSON-RPC 到 server → 结果回填
```

## 16. 快照 / 回放 / 一致性保证

- `test:snapshot`：keyless；ACP 启动真实 automation-server 示例，重放记录会话，diff 归一化 JSON-RPC + 重新持久化的日志；headless 用未导出的 JSONL driver。
- `test:web`：Chromium 重放浏览器输出对比 `apps/web/tests/snapshots/`。
- 运行时 invariant（`dsh-invariants`）：每个包一个 `./invariant` 伴生插件，注册包名断言（loop 请求重建、session 关系追踪、工具配对、状态机转换）。配置 allow/blocklist，可在 load 时关闭。
