# 05 二次开发指南

## 0. 铁律（改代码前）

1. 先读 `docs/architecture.md` 和本目录 01 文档，判断改动落在哪个扩展点。
2. **新行为挂扩展点，不要改 loop**：`agent/*`、`tools/*`、`fs/*`、`system-prompt/*`、`session/*` 事件是官方缝隙。改 `agent-loop` 必须同步改 `docs/architecture.md`。
3. 注册是效应：任何注册返回 disposer；HMR 安全（仓库对每个 registry 都有 HMR 测试）。
4. 模型可见 ⟺ 已记录：新增模型可见输入必须加 `SessionEventMap` 成员并写渲染。
5. 非平凡改动同一 PR 必须带 Agent Note（`.agents/notes/`，四态分类）。
6. 改前保存文件状态（git 或备份），按最小改动做。

## 1. 加一个工具（最快上手路径）

参照 `docs/cookbook/adding-a-tool.md` 与模板 `packages/fs/tool-fs`：

1. 建包 `packages/<group>/tool-<name>`（`package.json` + tsdown + vitest + README 双语占位）。
2. `apply(ctx)` 里 `ctx.tools.register(defineTool({...}))`：
   - `name`/`description`/`parameters`（JSON Schema，或 value-schema 简写）；
   - `execute(args, exec)` 返回 lossless JSON 值；观察/转发 `exec.signal`；
   - `output: { schema, render(args, value), presentationMeta? }`（模型内容 = render 的纯函数投影）；
   - 可选 `finalizeContent`、`isConcurrencySafe`、`timeoutMs`、`presentCall`/`presentResult`（UI 渲染意图，`generic`/`terminal`/`diff`/`locations` 等）。
3. 若需要上下文：`exec.deferContext(userMessage)`；需要停轮：`exec.concludeTurn()`。
4. 同时注册 `ctx.systemPrompt.section`（工具指南段，order 100-199）。
5. 测试：单元 + 非单元 REAL-composition 测试（boot cordis.yml 驱动）+ 若模型可见变化加 keyless snapshot。

## 2. 加一个 LLM 适配器

参照 `packages/llm/llm-deepseek` 与 `docs/cookbook/adding-an-llm-adapter.md`：

- `ctx.llm.registerAdapter([providerId], adapter)`；adapter 实现 `stream(options)`（返回 `AsyncIterable<StreamChunk>`）、`providerInfo`、可选 `listModels`/`resolveModel`/`providerRetryPolicy`。
- 必须把 provider wire 翻译成规范 `StreamChunk` 词汇；失败归一化成 `finish: {kind:'error'|'aborted', failure}` 或抛 `LlmError`。
- 若 provider 支持 reasoning effort / default maxTokens，用 `resolveModel` 元数据 + `adapterDefaults` 标记。
- 供应商配置走 settings namespace + `registerConfigurableProviders` + 可选 `registerModelDiscovery`。

## 3. 加一个新能力缝

参照 `packages/shell` 三件套：

1. Definition 包：抽象 `Service` 认领 `ctx.<key>`，定义词汇类型与事件（`@mode`）。
2. Provider 包：`apply` 里注册实现；单 provider 缝"第二个加载即抛"，多 provider 缝（如 subagents/llm）用注册表。
3. Consumer 包：通常是模型工具；Consumer 通过 `inject` 或 `ctx.get()` 消费服务。
4. 写 `docs/capability-seams.md` 对应条目 + 子系统页 + README。
5. 覆盖计划：unit + e2e + snapshot 三层一起规划。

## 4. 加一个会话事件

1. 在包内 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'your/event': {...} } }`。
2. 若消息产生型：必须携带 `surfaceOp`（append 或 replace）与 `sourceEventSeqs`。
3. 若可被旧 reader 跳过：`ignorable: true`；默认 unknown 是"拒绝重建"。
4. 若模型可见：写 `deriveEventMessage` 投影规则或消息构造，并保证从日志可重建（invariant）。
5. 检查 `SESSION_FORMAT_VERSION` 是否要 bump：只有结构变化（header/envelope/核心事件语义/surface 机制）才 bump。

## 5. 改持久化后端

1. 实现 `SessionPersistence`（`locate/create/append/prepare/load/inspect/readFrom/list/...`）。
2. 把写路径接 `PersistenceCoordinator`（批量、缓存、恢复统一由它编排），否则要自己处理 `session/flush` 与 torn-tail。
3. `SCHEMA_VERSION` 单调递增；旧格式拒绝而非迁移（未发布期）。
4. JSONL 是默认；SQLite 是 opt-in 展示格式多样性。

## 6. 改 Web UI

- 客户端包都在 `packages/client/ui-*`：槽（slots）注册 + keyed renderer（如工具卡 `ui-tool`）。
- 数据经 `connection`（RPC + 事件流）→ `runtime` 服务；组件**渲染日志事件投影**，不要自己维护会话状态。
- 新增设置卡：`docs/cookbook/adding-a-settings-card.md`。
- 浏览器快照 `test:web`（Linux PR 门禁）要覆盖 GUI 变化。

## 7. 测试与门禁速查

| 场景 | 命令/门禁 |
|---|---|
| 单元测试 | `pnpm run test`（vitest，`tests/**`） |
| 覆盖门禁 | `pnpm run test:coverage`：`packages/*/*/src` 单文件 100% |
| 真实 API | `pnpm run test:e2e`（自跳过无 key） |
| 转录快照 | `pnpm run test:snapshot`（`-t <name>` 过滤） |
| Web 浏览器快照 | `pnpm run test:web` |
| 类型 | `pnpm run typecheck` |
| lint | `pnpm run lint`（oxlint） |
| 卫生 | `pnpm run hygiene`（knip/publint/workspace 约束/NodeNext） |
| 文档门禁 | `pnpm run doc-sync`（含 verify-doc-budgets、verify-export-jsdoc、md-links） |
| 提交前 | `git diff --cached --check`（尾换行） |

原则：按 diff 表面选最小检查集（`dsh-pre-push-checks` skill 有流程）；不要默认全量；CI 拥有穷举覆盖。测试优先真实实现，只在 LLM/网络/时钟边界 mock；e2e 断言"外部世界"而非 agent 自述。

## 8. Agent Notes 规则（.agents/notes/）

- 目录：`proposed/`（提议）→ `implemented/`（实施）→ `archived/`（里程碑归档，**冻结**）；`rejected/` 是拒绝记录。
- 命名：`YYYY-MM-DD-<slug>.md`，按 kind 子目录（architecture/feature/bug-fix/process/simplification/testing）。
- 归档有清单（manifest）与分类门禁（`verify-agent-note-classification` 等脚本）。
- 归档后的 note 不是现行权威，不能编辑；重要决策引用 implemented 记录。

## 9. 文档规范要点

- 每包 README 双语（`README.md` + `README.zh.md`），有字预算门禁与"Model Experience"章节要求。
- 文档一句话一行（物理行），一个事实一个家，当前态散文。
- 术语用词汇表规范：seam/scope/turn/step/goal/round/Ralph，不要自创同义词。
- 生成目录（tool-catalog/config-catalog/module-graph/event 矩阵）用 `pnpm run gen-*` 重新生成，不手改。

## 10. 常见坑（读代码时的实测观察）

- **不要绕过 `session.append` 直接改 log**：seq 连续、lossless JSON、surface 校验都在 append 边界。
- **不要给 loop 直接注入消息**：用 `agent.inject()`（不唤醒）或 `agent.steer()`（唤醒下一步），都会走 inbox + pre-step 决策。
- **waterfall 忘 `next()` 会静默短路**：拦截器挂到 `agent/pre-step` 却忘 delegate，模型将看不到任何输入。
- **scoped 注册别用全局 ctx**：per-agent 工具/提示段必须通过 `agent.ctx`，否则所有 agent 都可见。
- **persistence 不是同步的**：读持久化状态前先 `ctx.sessions.flush(session)`（schedule 和 checkpoint 都是这个模式）。
- **测试不要 import 其它 spec**：fixtures 放 `tests/harness.ts`，避免重复注册 describe 与重复真实 API 调用。
- **Code Mode 下模型直接调用原生工具是设计内的拒绝**，不是 bug：提示里只有 `run_code` + SDK。
