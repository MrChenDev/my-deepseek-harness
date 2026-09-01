# 03 核心算法逐行剖析

> 行号基于分析时的 HEAD；仓库会演进，用 `rg` 按符号名重新定位。这里剖析的是"为什么这样写"和"怎么运行"，对应代码路径已给出。

## 1. Agent Loop 状态机（`packages/core/agent-loop/src/agent.ts`）

### 1.1 相（phase）定义

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort; lastTurn; wakeRequested }
  | { kind: 'running'; abort; turn; step; wakeRequested }
```

`ReactLoopAgent` 是驱动一个会话的有限状态机。**idle** 无活动；**maintenance** 跑非 turn 任务（压缩、标题等），外部状态仍显示 idle；**running** 是 driver 在跑 turn。`setPhase()` 只在状态真正翻转时发 `agent/status`。

### 1.2 输入与唤醒

- `followup` → `send(input, 'next-turn', true)`：普通下一轮，唤醒 driver。
- `steer` → `send(input, 'next-step', true)`：向最近一步边界投喂并唤醒。
- `inject` → `send(input, 'next-step', false)`：注入上下文**不唤醒**，等下一次 wake 才被消费。
- `send()` 的关键分支：若 wake 发生在已中止的活动之后，目标被重分类为 `next-turn`（避免唤醒加入一个已死活动），并走 wake-latch 路径。
- `wakeDriver()`：idle 时同步创建 running 相并 `loopCtx.agents.withInitiator(this, () => this.kick())`——**initiator** 机制让异步 driver 工作期间 `ctx.agents.requireInitiator()` 能拿到发起 Agent（工具执行需要它）。非 idle 时把 wake 锁存（`wakeRequested = true`），在维护任务收敛后重放。

### 1.3 turn()：一轮的骨架

1. `turn = phase.turn + 1`，先追加 `turn/start`（**开 turn 先于一切**，reject/空输入也会留痕）。
2. 循环内每次 `preStep()`：
   - `inbox.claim(target, turn)` 从队列取出该步的输入；
   - `systemPrompt.assemble(assembleContextFor(this, signal))` 组装提示（scope=本 agent）；
   - `RuntimeContextProjection.project(...)` 生成动态运行上下文快照（见 §9）；
   - 走 `agent/pre-step` **waterfall**（可 reject 或改写 messages；`agent-instructions`、`compaction-basic`、`plan-mode`、hooks、time-context 等都挂这里）。
3. 决策进入（enter）时：追加 `step/start`，逐条追加 `user/message`（surfaceOp append），执行 `this.step(assembly)`，`finally` 追加 `step/end`。
4. **max-tokens 粘性**：一旦某步触顶，后续正常完成的步不得把 turn 结局降级。
5. 停轮前：若 turnEnds 且 `inbox.nextStep` 为空，走 `agent/turn-stopping`（serial，监听器可以 `agent.steer()` 让机器继续跑一步）；数据决定结局。
6. 所有出口都追加 `turn/end { turn, reason }`；失败被结构化：`LlmError` 保留事实，其它错误拍平成 `{ message: errorChain, code: 'UNKNOWN' }`。
7. 循环条件：`inbox.hasPending` 为真 → 换新 AbortController、`step=0`、返回 true 再跑一轮（多轮合并到一个 driver 内）。

### 1.4 step()：一次模型请求 + 其工具执行

```text
buildRequest() → 准备 LLM 调用（冻结、绑定适配器注册）
  → 追加 request/header（initial/resume/change）与 request/context（路由变化时）
  → for await (chunk of stream)：追加 assistant/chunk + BlockAssembler.push
  → 流异常且已中止：把已流出的 text/reasoning 前缀作为 interrupted assistant/message 落库
  → finish.error/aborted → agent/request-error waterfall（llm-retry 可返回 {kind:'retry'}）
  → 组装 assistant/message（带 usage + sourceEventSeqs=chunk seqs）
  → 无 tool-call → {kind:'completed'}
  → executeToolCalls() → 返回 concluded? completed : null（还有 next-step 输入 → 再跑一步）
```

关键不变式：**每条 `assistant/message` 的 `sourceEventSeqs` 引用组成它的所有 chunk seq**；`request/header` 在 dispatch 前落库，让请求可从日志重建（`agent-loop/invariant.ts` 用 `llm/stream` 的 prepend 监听做运行时断言：请求必须冻结、必须带 sessionId、messages 必须等于 `deriveMessages()`、model/system/tools 必须等于折叠 header）。

### 1.5 buildRequest()：请求重建算法

1. 从 `session.requestHeader()`（增量折叠缓存）取持久化的 config 作为基线；**首请求**从 `AgentOptions`（provider/model/maxTokens）出发，恢复显式 effort 仅在路由匹配且 `adapterDefaults.reasoningEffort !== true` 时。
2. `agent/request` waterfall 让插件替换 config。
3. `llm.prepareCall(proposedConfig, signal)`：绑定当前适配器注册，解析模型能力（默认 maxTokens、reasoning effort 校验），返回一次性 `PreparedLlmCall.stream()`（同注册跨 header 记录与 dispatch，防 HMR 把能力结果与另一适配器组合）。
4. `canonicalHeader` 折叠 system + tools，比较 baseline 后追加 `request/header`。
5. 返回 `markAgentLoopRequest(deepFreeze({...header.config, messages: boundaryMessages, system?, tools?, sessionId, signal}))` —— 冻结是 invariant 的一部分。

## 2. 工具调度器（`packages/core/agent-loop/src/tool-calls.ts`）

**目标**：在"模型顺序"的约束下做并发调度。policy、结果、结果上下文全部按模型顺序提交，只有 dispatch/body 重叠。

算法：
1. 把所有 `tool-call` block 解析成 `PlannedCall`（参数 JSON.parse，非法 JSON 保留原文）。
2. `executeToolCalls` 循环：取第一个未调度 call，`ctx.tools.executionMode(exec)` 判 `parallel`/`exclusive`。parallel → 整组为 pool；exclusive → 单 call 为 barrier。
3. `runGroup`：
   - `startCall(i)`：先落 `tool/call` 事件（拿 seq）→ `scheduler.prepare`（pre-execute + guards，见 §3）→ dispatch/post-result/final-result 三态。
   - 有界滚动池：`fillPool` 在 `inFlight.size < maxParallelToolCalls` 且未中止时启动；**每启动一个就 `commitReady`**，保证前面的结果先按序提交。
   - `commitReady`：连续推进 `committed` 指针，对 post-result 走 `finalize`（含 post-execute），final-result 走 `finish`；追加 `tool/result`（`sourceEventSeqs=[callSeq]`），`additionalContexts` 逐个进入 next-step inbox（FIFO，位于记录的 tool/result 之后）。
   - 并行组中途出现 exclusive（`executionMode` 变为非 parallel）→ 停止补池，等当前池排空，exclusive 留给下一 barrier。
4. **中止语义**：abort 到达时——已启动的 call 排空并提交；未启动的 call 全部追加合成 `tool/result`（`Error: tool call aborted before dispatch`，`ABORTED_BEFORE_DISPATCH`）保证回放有效；返回 `aborted: true`，外层给剩余 planned 也追加合成结果。
5. **调度器内部失败**：停止新 dispatch，`Promise.allSettled` 排空已启动者，抛首个失败，**不伪造结果**（避免把真实失败伪装成取消）。
6. `concludesTurn` 从任一提交结果收集，任一为 true 则本轮结束。

## 3. 工具执行流水线（`packages/core/tools/src/index.ts`）

注册表把一次调用切成五个阶段，顺序固定：

```text
createExecution（token、参数 lossless 快照、finalizeContent 捕获、deferContext/concludeTurn 闭包）
  → prepareExecution：
     tools/pre-execute waterfall（allow/deny/ask）
     ask → ctx.approval（一次允许；rejected/cancelled/unavailable → deny）
     monotonic guards（只能 deny，不能复活）
     callerCancelled 检查（按 bodyInvoked 区分 ABORTED / ABORTED_BEFORE_DISPATCH）
  → dispatchScheduledExecution：
     tools/execute waterfall（timeout/retry/metrics 包装）包住 dispatchToolBody
     dispatchToolBody：fuse 原始 caller signal 与 wrapper 替换 signal → tool.execute(args, exec)
     normalizeDispatchResult（wrapper 自产结果过 output 契约）
     deferContexts 合并到 additionalContexts
  → finalizeScheduledExecution：tools/post-execute waterfall（accept/block + additionalContexts）
  → finishScheduledExecution：
     materializeFinalResult（lossless-JSON 冻结）
     快照的 finalizeContent 回调（只能换 content，不能抛）
     tools/result 同步通知（冻结的权威结局）
```

要点：
- **Code Mode collapse 在策略之前**：模型直接调用非 `run_code` 原生工具在 `createExecution` 里就被定为 final-result（`UNKNOWN_TOOL` + 路由提示），pre-execute 监听器和审批**永远看不到**它（防止策略层批准一个必然失败的调用）。nested（带 parent token）不受 collapse 限制。
- 参数 getter 可能在 `snapshotJsonValue` 时被替换，所以 `finalizeContent` 在**参数物化前**捕获。
- 结果必须过 `output.schema`（JSON Schema）并 lossless 快照；`render` 与 `presentationMeta` 是纯函数，异常折叠成 `INVALID_TOOL_OUTPUT`。
- `tools/result` 事件只给冻结视图，观察者不能改结局。

## 4. 流式组装（`packages/llm/llm/src/assembler.ts`）

`BlockAssembler` 是 chunk→message 的唯一规范算法：
- `partials: Map<index, PartialBlock>` + `order: number[]` 保持流顺序。
- 容忍 delta-only 协议（无 block-start/end 时按 delta 类型推断）；`block-end` 之后到达的 delta 被忽略（坏流防内存/防破坏）。
- `assembled()` 是**唯一共享的 keep/drop 决策**：`finish.kind === 'max-tokens'` 时丢弃所有 tool-call block（无法安全执行）；replay envelope 的 per-block 元数据与保留块同步裁剪，长度不匹配则整体丢弃 envelope。
- `interruptedBlocks()`：仅保留非空白 text/reasoning 已关闭/未关闭块，tool-call 一律省略（中断先于 dispatch，不能伪造结果）。

## 5. Session 表面折叠（`packages/core/session/src/surface.ts`）

- `foldSurface(events)` 是全日志重放：`planSurfaceEvent` 校验 seq 连续性、surfaceOp 合法、sourceEventSeqs 必含被 shadow 的每个节点、tool/result replace 只能改 content（`assertToolResultRewrite`）。
- `SurfaceManager` 做增量折叠：`validateNext` 先验证不提交；`append` 之后 `_processDelta` 在下次访问时推进。
- `deriveMessages()` 缓存：surface nodes 投影一次；`replaceGeneration` 变化（压缩）时全量重建。返回新数组但元素共享深冻结的日志对象。
- 为什么需要 surface 而非直接扫 log：压缩 replace 会把一段历史折叠成一条摘要 user message，旧节点仍留在 append-only log（人类可见的原始转录），但模型只见替换节点。

## 6. 压缩（`packages/compaction/compaction-basic/src/`）

- 触发：`compactIfNeeded(agent, trigger, signal)`，trigger = `pressure`（token 压力，读最新 durable routed header）或 `context-overflow`（provider 确认超窗）。
- `selectCompactableRange`：在 surface 上选一段；`toolPairingBalancedBefore/After` 保证 assistant tool-call 与 tool/result 配对不破（不能把一次调用和它的结果拆到替换边界两侧）。
- 事务：先追加 `compaction/start`（durable 锁，一个 session 同时只能一个压缩事务）→ LLM 摘要（`summarizeWithLlm`，按 token-meter 定价、收敛重试、retainTokens 保留尾部）→ 追加带 `{op:'replace', start, end}` surfaceOp 的摘要 user message（source = `compactCheckpointSource`，含 CompactionId）→ `compaction/end`。
- `compactNow` 走 `agent.runMaintenance`（必须 idle）；`ManualCompactionError` 分类 busy/cancelled/changed/summary/commit/persistence。
- 失败尝试留在日志中可见；压缩后 `deriveMessages` 自动失效重建。

## 7. 持久化格式与恢复

### JSONL 后端（`session-persistence-jsonl/src/format.ts` + `zstd.ts`）

- 每个会话一个目录：`<root>/--<normalized-cwd>--/<encoded-id>/session.jsonl[.zstd]`。
- 默认压缩为**校验和 Zstd 帧**：第一帧必须恰好是 header 行（`assertZstdHeaderFrame`）；后续每帧是事件行块。逐帧校验和 + 独立可解码 → torn-tail 可恢复：截断到最后一个完好帧边界并回收其中事件。
- `packChunks`：连续 `assistant/chunk` 的同类 delta（text/reasoning/tool-call）打包成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 行（~60% 体积）；读取无条件解包，布局不依赖开关。
- 写路径：`PersistenceCoordinator` 缓冲（`writeBatchMaxDelayMs` 窗口）→ 批量 append → `session/flush` 屏障（parallel，全部后端参与）；`prepare` 有 cold session 缓存。

### SQLite 后端（`session-persistence-sqlite/src/schema.ts`）

- Schema 17：`events(session_id, seq)` 复合主键；scalar 行存单事件，packed 行物理 type 用 `text-chunks` 等 + `ignorable=0` 作物理判别符；provenance 序列 delta 编码。
- 打包上限：1 行 ≤ 1024 事件、≤ 1 MiB 未压缩 UTF-8；读取重建每个原始 seq/time/token 边界/参数片段。

## 8. Typert 类型图管线（`packages/typert/generator/`）

1. `analyzer.ts`（2943 行）：用 TS 编译器 API 遍历类型程序——收集 Service（抽象类）、事件（`Events` 合并接口 + `@mode` JSDoc）、对象（`@typert object` 标注）、方法成员（property/method/getter/setter/call/construct/index）、Remote 标注（`@Remote`/`@RemoteScope`）。
2. `model.ts` 建中间模型；`emitter.ts`（870 行）产出 `InvocationDescriptor` 清单、严格 codec（zod v4 schema 引用）与类型面；`cordis-catalog.ts` 生成服务/事件目录。
3. 产物经 `./typert` export 发布；`loader` 在 Loader 条目挂载时发现并 `validateTypertManifest`（面、schema、model、invocations 全字段校验），失败 loud。
4. `registry/service.ts`：运行时注册表（对象/服务/lookup/Context 提供方），`typert.lookups.register('session', ...)` 把 `SessionId → Session` 解析绑进网关。
5. `api/gateway` 的 Host 侧 `invoke()`：按 descriptor 解析 Cordis Service → 校验具名参数 → lookup 解析 → 调业务方法 → 结果 codec 校验；Client 侧 `ctx.remote` 生成 `remote.<namespace>` 子服务方法，走 Connection `/api`。

## 9. 动态运行上下文投影（`agent-loop/src/runtime-context.ts`）

- `RuntimeContextProjection` 跟踪"最近一次保留的快照"：从日志尾部扫到最后一个 system-prompt 拥有的 user/message（surface 上），之后监听 `session/event` 增量维护。
- `project(current, sections)`：内容没变 → 不产出；变了 → 产出 `createUserMessage`（source = `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot', sections}`）；清空时产出固定 `CLEARED` 文本。
- 这个"运行时上下文快照"以 user/message 落库 → 模型可见即已记录，且压缩/回放时与普通消息一致。

## 10. Scope 层解析（`packages/core/scope/src/` + tools/system-prompt 的 view 逻辑）

- `ScopedLayers`：global layer + 每个 scope 一个 layer；`chainLayers(scope)` 返回 [最远祖先 ... 自身]。
- 工具可见性 `view(scope)`：
  - inherited = global + 链上每层（近者遮蔽远者，Map.set 覆盖）；
  - 每层 restriction 用 `admits(name)` 交集过滤（**只滤继承面**，自己的注册豁免——子代理上报工具不被父限制误杀）；
  - 自己的 layer 最后插入（遮蔽）；
  - 非 native 模式追加保留 `run_code` transport（restriction 不能删它）。
- 事件派发用 `scopeTarget(base, key)` 造 carrier：带 key 的监听器只收自己 scope 的事件，无 key 的监听器全局收。

## 11. LLM 适配器边界（`llm/llm/src/index.ts` + `llm-deepseek/src/adapter.ts`）

- `LlmRuntime.adapterStream` 是最终适配器边界：选择适配器 → 构造 iterator → 迭代；**适配器构造/迭代失败归一化成终端 failure chunk**（`adapterFailureChunk`，区分 aborted/error），而消费者/中间件失败保持抛出。
- 适配器必须把 provider wire 翻译成 `StreamChunk`（block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish）；`finish` 可带 `replayState`（provider 私有 JSON，供同适配器回放）。
- `forAdapter`：切掉"历史 assistant 消息里属于其它适配器的 replayState"（保留 provider/model 身份，只丢私有回放状态）。
- `prepareCall` 的 `adapterDefaults` 标记（`reasoningEffort/maxTokens` 是否由适配器物化）会写进 `request/header`，下一请求据此恢复"显式用户选择"而非默认值。
- 错误词汇：`LlmError`（NO_ADAPTER、UNSUPPORTED_REASONING_EFFORT、INVALID_PREPARED_CALL 等）+ `LlmFailure`（message/code/status/providerRetryAfterMs/requestId）。

## 12. 其它值得一提的算法

- **请求头折叠**（`session/src/request-header.ts`）：`foldRequestHeader(events, base?)` 增量折叠；`canonicalHeader` 保证空可选字段缺省；`headerEquals` 深比较。
- **打包 JSON**（`session/src/json.ts`）：`snapshotJsonValue` 一次递归读取+校验+拷贝（stateful getter 无法给校验和存储提供不同值），拒绝 BigInt/函数/symbol/undefined/负零/NaN/循环/稀疏数组/Map/Set/Date/class。
- **Chunk 行编解码**（`session/src/chunk-rows.ts`）：`packChunkRuns` 同类 delta 运行打包 + 行内 seq/time 恢复。
- **inbox**（`core/agent/src/inbox.ts`）：两个队列（next-turn / next-step）+ 取消 splice 日志；claim 事件驱动。
- **进程树清理**（`subprocess-local`）：POSIX detached + pgid 信号，Windows `taskkill /T /F`；退出后管道 drain grace，防残留后代把 outcome 永久挂起。
- **win32 ACL 沙箱**（`sandbox-windows-acl`）：restricted-token runner + 每会话私有 temp 目录/SID + workspace SID 常驻授权。
- **输出保留**（`util/output-retention`）：TextRetainer 在预算内做 head/tail 预览（spill 策略的预览引擎）。
