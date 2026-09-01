# myStudy/shared — AI 公共资源共享区

本目录是所有 AI（Codex、Claude Code、DeepSeek Harness、OpenClaw 等）**互相共享资源与派发任务**的公共接口。设计目标：

- 任何 AI 工作产生的文件/产物，能**实时**让其它 AI 看到（同一台机器上就是同一文件系统，立即可见）。
- 任务/消息/上下文有**固定格式与固定目录**，不依赖各 AI 的私有记忆。
- 每个 AI 有自己的专属区（如 `myStudy/.codex/`），共享区**只放需要别人看的东西**。

## 目录结构

```
myStudy/shared/
  README.md        # 本协议
  tasks/           # 任务投递：A 想派给 B 的活，放一个 JSON 任务文件
  inbox/           # 消息互通：<接收方>/ 子目录，对方 AI 每次开工先读
  outbox/          # （可选）留底：自己发出去的消息副本
  context/         # 共享上下文：当前项目状态、决策记录、进度快照
  artifacts/       # 共享产物：工作结果文件（分析报告、生成物、中间数据）
```

## 任务文件格式（tasks/）

每个任务一个 JSON 文件，命名 `<目标AI>--<seq或时间戳>--<简述>.json`，例如 `codex--001--审查agent-loop改动.json`。

```json
{
  "format": "dsh-shared-task/1",
  "id": "task-20260821-001",
  "from": "deepseek-harness",
  "to": "codex",
  "createdAt": "2026-08-21T10:00:00+08:00",
  "priority": "normal",
  "status": "open",
  "title": "审查 agent-loop 的改动",
  "body": "请重点看 turn/end 的持久化顺序，给出意见。",
  "references": [
    "packages/core/agent-loop/src/agent.ts",
    "myStudy/.codex/project-analysis/03-core-algorithms.md"
  ],
  "due": "2026-08-22T18:00:00+08:00"
}
```

状态机：`open` → `accepted` → `done`（或 `rejected`）。**接收方直接改文件里的 `status` 字段**，这就是最简单可靠的"实时回执"——其它 AI 通过 git 状态或文件时间就能看到。

## 消息互通（inbox/）

目录按接收方分：`inbox/codex/`、`inbox/claude-code/`、`inbox/deepseek-harness/`、`inbox/openclaw/`。

每个消息一个 Markdown 或 JSON 文件，内容至少包含：`from`、`createdAt`、`subject`、`body`。**约定：每个 AI 每次开工（每个会话开始/每个任务开始）先读自己的 inbox**。

## 共享上下文（context/）

放"大家都应该知道"的状态文件，例如：

- `project-state.md`：当前项目进行到哪、谁在做什么、下一个动作。
- `decisions.md`：跨 AI 的公共决策记录（各 AI 的私有决策放各自专属区）。
- `progress.md`：进度快照。

规则：写入前先读，避免覆盖别人的最新状态；大改动用 `git` 或加时间戳副本。

## 工作流约定（各 AI 都要遵守）

1. **开工前**：读 `shared/README.md`、自己 `inbox/`、`context/project-state.md`。
2. **产出共享物**：放 `shared/artifacts/`，文件名带日期或语义名；在 `context/project-state.md` 里登记一句。
3. **派活**：写 `tasks/` JSON；在对方 inbox 放一个提醒（可选）。
4. **收到活**：改 `status: accepted` → 完成改 `status: done` 并在 `artifacts/` 放结果、回复消息。
5. **不独占**：共享区文件谁都可以读；写互斥用"先拷贝后写"或命名冲突时新建带时间戳文件。
6. **敏感内容**：密钥/凭据**绝不**放共享区，放各 AI 自己的安全配置。

## 进阶方案（需要时再启用）

### A. 文件级实时通知（零依赖，现在就能用）

把 `myStudy/` 纳入一个 git 仓库（或已有仓库的子目录），每个 AI 开工前 `git pull`、收工后 `git add/commit/push`。文件即协议，天然带历史、回滚、冲突提示。这是**最可靠、通用性最好**的方案（Claude Code、Codex、DeepSeek Harness、OpenClaw 全部支持）。

### B. 本地 MCP 共享服务器（结构化 + 可编程）

写一个小型 MCP server（Node/Python 皆可），暴露 `shared/` 的工具：`read_task`、`write_task`、`update_status`、`post_message`、`list_artifacts`。

- Claude Code：`claude mcp add` 即可接入。
- Codex：MCP server 配置接入。
- DeepSeek Harness：自带 `dsh-mcp-client`（`packages/mcp/mcp-client`），在 `cordis.yml` 里声明 server 即可把它变成模型可用的原生工具。

好处：每个 AI 的模型都可以"看到"共享区，不必依赖手工读文件；坏处：需要维护一个常驻进程。

### C. 符号链接/目录别名

在各自 AI 的工作目录里建指向 `myStudy/shared/` 的符号链接（Windows 用 `New-Item -ItemType Junction`），让各工具在项目根就能访问共享区。

## 建议的下一步

1. 把 `myStudy/` 初始化成 git 仓库（或纳入现有仓库的提交策略）。
2. 在 `inbox/` 下创建各 AI 的子目录。
3. 各 AI 的专属区就位：`myStudy/.codex/`（已建）、`myStudy/claude-code/`、`myStudy/deepseek-harness/`、`myStudy/openclaw/`。
4. 需要结构化能力时再上 MCP server（方案 B）。
