# Tech Resume Coach

面向计算机及相关专业大学生、应届毕业生的技术岗简历 Skill，覆盖实习、校招、秋招和春招。它负责内容诊断、岗位匹配、事实校验、修改建议、面试追问准备，并可按用户确认的事实生成 DOCX/PDF。

该包使用 `SKILL.md` + references 的目录形态，适配 Agent Skills 风格的运行环境。Claude Code、Codex、DeepSeek Harness 的发现目录不同，安装时将整个 `tech-resume-coach` 文件夹复制到对应技能目录。

## 快速开始

1. 按下方任一方式安装整个 skill 文件夹。
2. 新建会话并上传一份**可复制文字的 PDF 简历**，再说明目标岗位；有 JD 时一并上传。
3. 在 Codex 输入 `$tech-resume-coach`，在 Claude Code 或 DeepSeek Harness 输入 `/tech-resume-coach`，并说明要做简历诊断。

简历只接收 PDF。DOCX、PNG、JPG/JPEG 请先导出为 PDF。扫描版 PDF 需要 Agent 自带 OCR/视觉读取能力；否则请重新导出可搜索 PDF，或粘贴 PDF 导出的文本。

## 安装方式

### 方式一：用 npx 安装（Codex / Claude Code）

发布到 GitHub 后，可用通用安装器直接从仓库安装。先从 [Node.js 官网](https://nodejs.org/en/download) 安装 Node.js 22.20 或更高版本，重新打开终端并运行 `node --version` 确认版本；再把命令中的 `OWNER/REPO` 换成实际 GitHub 用户名和仓库名：

```powershell
npx skills add https://github.com/OWNER/REPO --skill tech-resume-coach --global --agent codex
npx skills add https://github.com/OWNER/REPO --skill tech-resume-coach --global --agent claude-code
```

`npx skills` 是第三方通用安装器，不是本 skill 自带的命令。其当前支持列表包含 Codex 和 Claude Code；列表没有 DeepSeek Harness。若暂时没有 Node.js，可用下方 Git 克隆、ZIP 或 Agent 协助安装方式。详见 [安装器说明](https://github.com/vercel-labs/skills) 和[支持的客户端](https://github.com/vercel-labs/skills/blob/main/docs/agents.md)。

### 方式二：Git 克隆到客户端技能目录

发布到 GitHub 后，将 `OWNER/REPO` 换成实际地址。以下为 Windows PowerShell 的用户级安装示例；仓库根目录应直接包含本 skill 的 `SKILL.md`：

```powershell
# Codex 与 DeepSeek Harness 可共同发现的用户级目录
$target = Join-Path $env:USERPROFILE '.agents\skills\tech-resume-coach'
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
git clone https://github.com/OWNER/REPO.git $target

# Claude Code 的用户级目录
$target = Join-Path $env:USERPROFILE '.claude\skills\tech-resume-coach'
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
git clone https://github.com/OWNER/REPO.git $target
```

DeepSeek Harness 也可安装到 `$env:USERPROFILE\.dsh\skills\tech-resume-coach`。项目级安装时，Codex 和 Harness 可发现项目根目录下的 `.agents\skills\tech-resume-coach`；Harness 也支持 `.dsh\skills\tech-resume-coach`；Claude Code 使用 `.claude\skills\tech-resume-coach`。不同客户端目录不同，单纯把仓库克隆到任意文件夹不会自动启用。参考 [Codex 技能目录](https://developers.openai.com/codex/skills)、[Claude Code 技能目录](https://code.claude.com/docs/en/skills) 和 [DeepSeek Harness 技能目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)。

### 方式三：下载 ZIP 后手动安装

解压 ZIP 后，将完整的 `tech-resume-coach` 文件夹复制到对应目录。不要只复制 `SKILL.md`，因为 PDF 备用解析器和详细规则也在子目录中。

| 客户端 | 用户级目录示例（Windows） |
|---|---|
| Claude Code | `%USERPROFILE%\.claude\skills\tech-resume-coach` |
| Codex | `%USERPROFILE%\.agents\skills\tech-resume-coach`（若配置了 `CODEX_HOME`，使用其技能目录） |
| DeepSeek Harness | `%USERPROFILE%\.dsh\skills\tech-resume-coach` 或 `%USERPROFILE%\.agents\skills\tech-resume-coach` |

### 方式四：让 Agent 帮忙安装

把 GitHub 仓库地址或解压后的文件夹路径发给 Agent，并使用下面的提示词：

```text
请将 tech-resume-coach 安装到本机的【填写客户端，如 Codex / Claude Code / DeepSeek Harness】用户级技能目录。
请先确认目标目录；如果已有同名 skill，先比较文件并告诉我，不要直接覆盖。
复制完整文件夹，确认目标目录内有 SKILL.md、references 和 scripts/vendor/pypdf，然后告诉我如何在新会话中调用。
```

安装后新建会话，让客户端重新发现 skill。若目标目录已有同名文件夹，先核对再更新，避免覆盖自定义内容。

## Python 与文件处理

### 只诊断 PDF 简历

如果 Agent 能直接读取附件中的 PDF，**不需要安装 Python**。若宿主读取失败，skill 的备用解析脚本需要本机已有 Python 3；`pypdf` 已随 skill 打包，不需要单独安装。该脚本只能读取 PDF 已有的文字层，不负责扫描件 OCR。

### 生成 DOCX/PDF 简历

本地导出脚本需要 Python 3、`python-docx`、`reportlab` 和可用的中文字体。若还没有 Python：

1. 从 [Python 官方下载页](https://www.python.org/downloads/) 下载适合系统的 Python 3 并完成安装。Windows 安装后重新打开 PowerShell。
2. 进入 `tech-resume-coach` 文件夹，确认 Python 可用：

```powershell
py -3 --version
```

3. 安装导出依赖：

```powershell
py -3 -m pip install -r requirements.txt
```

macOS/Linux 通常使用 `python3` 命令：先运行 `python3 --version`，再在 skill 文件夹运行 `python3 -m pip install -r requirements.txt`。若命令不存在，请先通过 Python 官方下载页或系统的软件包管理器安装 Python 3。

仅做 PDF 诊断时无需安装 `requirements.txt` 中的导出依赖。`npx skills` 安装器需要 Node.js，但这与 Python 依赖无关。扫描版 PDF 若宿主没有 OCR/视觉读取能力，不要为了使用 skill 临时安装 OCR 软件；改用可搜索 PDF 或粘贴文本。更多限制见 `references/file-handling.md`。

## 用法示例

- “按后端开发暑期实习 JD 诊断这份简历，给我评分和前三项修改建议。”
- “我准备参加今年秋招，帮我把课程项目改写成更适合嵌入式软件岗位的内容。不要编造数据。”
- “先检查简历中的事实和待补充信息，等我确认后再生成 DOCX 和 PDF。”

## 目录

- `SKILL.md`：通用工作流与能力边界。
- `references/`：岗位地图、评分规则、改写、招聘季研究和文件处理说明。
- `scripts/`：本地可选解析与导出工具。
- `examples/resume.example.json`：纯虚构的导出格式示例。

## 当前边界

- 简历文件输入统一为 PDF；PDF 文本层读取最可靠，扫描件、加密件和损坏文件可能无法完整读取。
- 招聘要求和招聘季会变化；具体结论需要当年 JD 或可核实来源。
- 评分是内容诊断，不等于通过率或录用概率。
- PDF 诊断优先依赖宿主 Agent 的文件读取能力；备用文本解析器随包提供，无需单独安装 `pypdf`。DOCX/PDF 导出依赖单独列明的 Python 包及中文字体。
- 安装路径以工具当前版本和本机配置为准；Codex 可通过 `CODEX_HOME` 改变用户级目录，DeepSeek Harness 也支持自定义技能目录。
