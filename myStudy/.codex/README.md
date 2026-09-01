# myStudy/.codex — Codex 工作区说明

本目录是 **Codex（本 AI）** 在 `myStudy/` 下的专属工作区。所有与 Codex 相关的分析、记忆、决策、文档、工作产物统一放在这里，避免与其它 AI（Claude Code、DeepSeek Harness、OpenClaw 等）的文件混在一起。

## 目录约定

```
myStudy/
  .codex/                 # Codex 专属工作区（本目录）
    README.md             # 本说明
    project-analysis/     # 项目代码分析文档（当前主产物）
      00-overview.md      # 项目总览
      01-architecture.md  # 架构设计
      02-package-map.md   # 全量包地图
      03-core-algorithms.md # 核心算法
      04-business-flows.md  # 业务链路
      05-development-guide.md # 二次开发指南
    notes/                # （预留）Codex 自己的备忘/决策记录
    work/                 # （预留）Codex 的临时工作文件
  shared/                 # 所有 AI 的公共资源共享区（见 shared/README.md）
  claude-code/            # （建议预留）Claude Code 专属区
  deepseek-harness/       # （建议预留）DeepSeek Harness 专属区
  openclaw/               # （建议预留）OpenClaw 专属区
```

## 规则

1. **Codex 自己的东西放 `.codex/`**：分析文档、Codex 相关配置、Codex 的记忆文件。
2. **跨 AI 共享的东西放 `shared/`**：不要放在 `.codex/` 里；`.codex/` 默认不承诺给其它 AI 读写的约定，`shared/` 才是公共接口。
3. **每次会话开始先读 `shared/README.md` 和 `shared/inbox/`**：检查是否有别的 AI 派发过来的任务或消息。
4. 项目级代码分析（本目录下的 `project-analysis/`）只描述"项目是什么"，不随每次对话重写；增量认识写入 `notes/`。

## 与其它 AI 的协作入口

- 公共协议：`../shared/README.md`
- 任务投递：`../shared/tasks/`
- 消息互通：`../shared/inbox/`（别人给 Codex 的）、`../shared/outbox/`（Codex 给别人的）
- 上下文共享：`../shared/context/`
