# 00 项目总览（DeepSeek Harness）

> 分析日期：2026-08-21。源码以工作区当前 HEAD 为准。本目录是「地图 + 深度剖析」两层结构：先看总览和架构，需要细节时按 `02-package-map.md` 和 `03-core-algorithms.md` 中的文件/行号定位。

## 1. 项目是什么

DeepSeek Harness（简称 dsh）是一个 **基于 vendored Cordis 的插件式 AI Agent Harness**。核心思想一句话：**一切皆插件**——包括模型适配器、工具注册表、会话日志、乃至 agent loop 本身，全部是可替换的 Cordis 插件。没有特权内核可打补丁，扩展方式就是在旁边挂一个插件。

仓库形态：pnpm workspace 单仓（monorepo），`packages/` 下 **226 个 npm 包**（`@deepseek-ai/dsh-*`），TS 源码约 **42 万行**；另有 Python SDK、原生 Landlock 启动器、Web 客户端、文档站。

## 2. 规模数据（实测）

| 区域 | 文件数（排除 node_modules/lib/dist） | 说明 |
|---|---|---|
| packages/ | 3940 | 226 个 workspace 包，TS 约 42 万行 |
| docs/ | 330 | 架构/子系统/菜谱/生成目录 |
| examples/ | 626 | 可运行 cordis.yml 组合 + e2e/快照场景 |
| .agents/ | 1767 | Agent Notes + 仓库技能（skills/） |
| scripts/ | 178 | 门禁与生成器 |
| apps/ | 291 | cli（dsh 启动器）+ web |
| python/ | 33 | Python SDK 与打包运行时 |
| native/ | 50 | landlock-run 原生启动器 |
| vendor/ | 74 | vendored Cordis 框架源码 |
| website/ | 5 | VitePress 投影 |

## 3. 顶层目录

| 目录 | 内容 |
|---|---|
| `vendor/` | 源码级别的 Cordis 框架快照（cosmokit、schemastery、cordis、loader、include、group、timer、hmr、logger-console），统一改名为 `@deepseek-ai/*` scope；更新走 `vendor/README.md` 的同步流程 |
| `packages/` | 全部业务包，按组分子目录：core、llm、tools 系、session 系、subagent、workflow、client（Web UI）等 |
| `python/` | `deepseek-harness-sdk`（高层 turns API + JSON-RPC 客户端）和 `deepseek-harness-runtime-bin`（打包运行时） |
| `native/` | `landlock-run`：Landlock 自限制后执行启动器（Linux 沙箱），npm 三包族 |
| `examples/` | 可运行的 `cordis.yml` 叶子（agent-spine、acp、jsonrpc 等），每个都有 keyless + with-key e2e 冒烟 |
| `apps/` | `cli`（`dsh` 命令）、`web`（浏览器端应用） |
| `scripts/` | 全部门禁与生成器（`run-gates.ts` 是总入口） |
| `docs/` | 架构文档、子系统参考、cookbook、生成的目录（module-graph、tool-catalog、config-catalog、event 矩阵） |
| `.agents/` | Agent Notes（proposed/implemented/archived/rejected 四态）+ 仓库专用 skills |
| `website/` | docs 的 VitePress 投影 |

## 4. 常用命令（来自根 AGENTS.md，实测可用性以环境为准）

```sh
pnpm install                 # 安装（node ^22.19 || >=24）
pnpm run test                # vitest 单元测试
pnpm run test:coverage       # CI 覆盖率门禁：packages/*/*/src 单文件 100%
pnpm run test:e2e            # 真实 API 测试（无 DEEPSEEK_API_KEY 自动跳过）
pnpm run test:snapshot       # 无 key 的 ACP/headless 回放快照；-t <name> 过滤
pnpm run typecheck
pnpm run lint                # oxlint
pnpm run duplication         # 跨文件 TS 克隆检测
pnpm run build               # tsc 出 lib/types + tsdown 打包
pnpm run hygiene             # knip + publint + workspace 约束 + NodeNext 消费检查
pnpm run doc-sync            # 所有文档门禁
pnpm run website:build       # VitePress 构建（兼死链检查）
pnpm dsh --profile headless "task"   # 从源码跑一次任务（需要 key）
pnpm run demo:cordis / demo:acp      # 演示（需要 key）
pnpm run test:web            # Chromium 浏览器快照（Linux PR 门禁）
```

## 5. 一句话架构地图

```
dsh 命令 (apps/cli)
  └─ app-boot：加载 .env、解析 profile（bundle 栈）、驱动 Cordis Loader
       └─ bundle 层：base（默认行集）→ web-app/headless → 用户 cordis.patch.yml
            └─ Cordis 插件树（一切皆插件）
                 ├─ ctx.sessions     事件源会话日志（append-only SessionEvent）
                 ├─ ctx.agents       Agent 注册表 + agent/* 事件
                 ├─ ctx.agentLoop    唯一具体 loop 驱动（ReactLoopAgent）
                 ├─ ctx.systemPrompt 系统提示组装
                 ├─ ctx.tools        工具注册表 + pre/guard/execute/post/result 流水线
                 ├─ ctx.llm          LLM 适配器注册表 + 流式词汇
                 ├─ ctx.sessionPersistence 持久化缝（JSONL/SQLite 后端）
                 ├─ ctx.compaction   压缩（历史摘要替换）
                 ├─ ctx.subagents    子代理缝（进程内/Codex/Claude Code/ACP/DSH SDK）
                 ├─ ctx.workflowEngine 工作流脚本引擎（Ralph 循环）
                 └─ ... 其余全部能力缝（fs/shell/web/lsp/terminal/skill/...）
```

## 6. 必须知道的核心文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 架构总纲：Cordis、profile/bundle、事件、turn 流、session log、能力缝 |
| `docs/cordis-primer.md` | Cordis 五个概念 + 四种事件派发模式 + waterfall 语义 |
| `docs/glossary.md` | 领域词汇：seam、scope、turn/step/round、goal、Ralph |
| `docs/capability-seams.md` | 能力缝全景图（478 行，强烈建议通读） |
| `docs/event-producer-consumer.md` | 全事件生产/消费矩阵（带文件行号） |
| `docs/tool-execution-pipeline.md` | 工具执行流水线 mermaid 图 |
| `docs/agent-lifecycle.md` | 序列图 |
| `docs/subsystems/*.md` | 每个子系统一页，带生成的 Cordis API 参考 |
| `docs/development.md` / `docs/testing.md` | 工程与测试约定 |
| `docs/module-graph.md`（生成） | 1678 行模块依赖图 |
| `docs/tool-catalog.md`（生成） | 所有工具 schema 与 UI 展示意图 |
| `docs/config-catalog.md`（生成） | 所有插件配置项 |
| `.agents/notes/` | Agent Notes：决策、事故、简化记录（implemented 是现行权威，archived 冻结） |

## 7. 阅读顺序建议（新接手者）

1. `docs/architecture.md` + `docs/glossary.md`（30 分钟建立心智模型）
2. `docs/cordis-primer.md`（Cordis 五概念，必修）
3. `docs/subsystems/core.md`（loop 如何驱动会话）
4. `docs/subsystems/session.md`（事件源 + surface）
5. 本目录 `03-core-algorithms.md` 的「agent loop 状态机」和「请求重建」两节（带代码行号）
6. `docs/capability-seams.md`（扩展模型）
7. 动手前读 `docs/development.md` + 根 `AGENTS.md` 约定

## 8. 重要事实核对（写文档时实测）

- `packages/` 内 226 个含 package.json 的包（depth ≤ 2）。
- session 格式版本 `SESSION_FORMAT_VERSION = 0`（未发布，无兼容承诺，后端拒绝旧格式）。
- 默认并行工具调用上限 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`。
- 默认持久化：JSONL 后端，zstd 压缩 + 可选打包 chunk 行（约 -60% 体积）。
- 运行时间隔：当前工作树 `.gitignore` 有既有未提交改动，与本次分析无关，未触碰。
