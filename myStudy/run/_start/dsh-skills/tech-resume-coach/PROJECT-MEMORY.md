# 项目记忆：Tech Resume Coach Skill

## 目标与已确认需求

- 主要用户：计算机科学与技术、软件工程、物联网工程、数据科学与大数据等专业大学生，尤其应届毕业生。
- 场景：找实习、校招、秋招和春招；岗位覆盖研发、开发、嵌入式、硬件、数据工程、测试、运维等技术方向。
- 交付：可自行安装或由 Agent 安装的 skill 包，目标 Claude Code、Codex、DeepSeek Harness。
- 重点：简历内容、岗位匹配、打分、优缺点与改写建议；不把简历样式模板作为重点。
- 暂无脱敏简历与 JD；首版使用虚构的结构示例，不用真实个人信息。
- 可参考 nuwa-skill 的方法，但核心采用可核实的校招流程、岗位证据和文件处理规则。

## 实施决策

- 在 `E:\codex project\tech-resume-coach` 创建独立包，不改动工作区其他项目。
- 采用一份 Agent Skills 风格 `SKILL.md`，详细规则放 references，三平台只在安装目录上做说明。
- 企业偏好和招聘时点不硬编码；需要时查当年官方招聘页/JD，区分事实与推断。
- 不编造经历、成果数字、个人贡献或企业招聘标准；评分是诊断分，不预测录用概率。
- 简历文件输入统一使用 PDF；优先用宿主原生 PDF 能力，备用解析脚本与 pypdf 源码随包分发，无需用户手工安装 PDF 解析依赖。脚本只提取含文本层的 PDF；扫描、加密或损坏 PDF 的限制需向用户说明。
- 技能可通过 ZIP/目录复制、GitHub 克隆、通用 `npx skills` 安装器和 Agent 协助安装分发。`npx skills` 官方支持列表当前包含 Codex/Claude Code，未列出 DeepSeek Harness；Harness 使用 `.dsh/skills` 或 `.agents/skills` 目录。GitHub 地址待用户提供后再补可直接复制的最终命令。
- Python 边界：宿主原生读取 PDF 时，简历诊断不依赖 Python；备用解析脚本和本地 DOCX/PDF 导出需要 Python 3。pypdf 已随包提供；导出依赖通过 `requirements.txt` 安装。
- 简历导出仍支持 DOCX/PDF；本地导出脚本依赖 python-docx、reportlab 和中文字体。
- 当前状态：首版文件已创建；skill-creator `quick_validate.py` 通过；两份脚本 `--help` 可运行。PDF 输入解析器随包提供；DOCX/PDF 导出仍需要可选 Python 包和中文字体。暂未安装 OCR/Office 依赖，也未在 Claude Code、Codex、DeepSeek Harness 中做真实安装验收。

## 待办

- [x] 验证 skill frontmatter、目录结构和未完成占位符（quick_validate 通过）。
- [x] 检查脚本帮助入口；未自动安装外部依赖。
- [x] 核对 Claude Code 与 DeepSeek Harness 安装发现方式；Codex 用户根按 `$CODEX_HOME/skills` 说明。
- [x] 已生成 `E:\codex project\tech-resume-coach-1.0.0.zip`，并核对压缩包含完整 skill 目录。
- [ ] 真实安装验收仍待执行。
- [ ] 未来有真实脱敏简历/JD 后，用校招实例做行为验收并更新评分规则。
