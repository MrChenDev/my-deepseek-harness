# DSH 日常脚本说明（myStudy/run/_start）

本目录存放多台机器（Windows + Fedora / Kali / Rocky Linux）共用的 dsh 维护脚本。脚本随 git 仓库同步：换机器后先拉取仓库，再按本文档准备环境并运行。

所有脚本都是幂等的（重复运行不会重复写入）。核心逻辑统一用 Node 实现（`.mjs`），Windows 的 `.cmd` 和 Linux 的 `.sh` 只是入口，行为一致；旧的 `.ps1` 保留但入口不再调用。

## 目录结构

```
myStudy/run/_start/
  pull-latest.mjs / .cmd / .sh          拉取代码
  upgrade-plugins.mjs / .cmd / .sh      升级插件
  install-dshmarket.mjs / .cmd / .sh    安装/升级插件市场
  sync-dsh-profile.mjs / .cmd / .sh     跨机器同步插件/配置/skills
  dsh-profile-baseline.json             插件与配置基线（web/desktop/全局 patch）
  dsh-skills/                           skills 基线
  README.md                             本文档
```

## 快速开始

### Windows

双击对应的 `.cmd`。脚本结束会 `pause`，按任意键关闭窗口。

### Linux（Fedora / Kali / Rocky）

```bash
cd /path/to/my-deepseek-harness
./myStudy/run/_start/pull-latest.sh
```

如果提示没有执行权限：

```bash
bash myStudy/run/_start/pull-latest.sh
```

### 首次准备（每台 Linux 一次）

要求：Node ≥24.9、pnpm 11.x、git、编译工具。

```bash
# Node + pnpm（nvm 方式，三个发行版通用）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
npm install -g pnpm@11
node -v && pnpm -v

# 编译工具
# Fedora / Rocky:
sudo dnf groupinstall "Development Tools"
# Kali (Debian 系):
sudo apt update && sudo apt install -y build-essential python3
```

git 凭据：首次 `git push` 需要配置 HTTPS credential helper 或使用 SSH。

### 首次冒烟测试（不写文件、不安装）

```bash
node myStudy/run/_start/pull-latest.mjs --dry-run
node myStudy/run/_start/upgrade-plugins.mjs --dry-run
node myStudy/run/_start/install-dshmarket.mjs --dry-run
node myStudy/run/_start/sync-dsh-profile.mjs diff
```

四条都正常输出后，再使用 `.sh` 入口正常执行。

## 脚本清单

| Windows | Linux | 作用 | 什么时候用 |
| --- | --- | --- | --- |
| `pull-latest.cmd` | `pull-latest.sh` | 拉上游、同步 dev/master、清理残留、按需安装、推送 | 上游有新提交时 |
| `upgrade-plugins.cmd` | `upgrade-plugins.sh` | 插件升到最新，检查 peer 兼容性 | dsh 升级后，或插件报“不兼容”时 |
| `install-dshmarket.cmd` | `install-dshmarket.sh` | 安装/升级插件市场 | 新机器、插件市场异常时 |
| `sync-dsh-profile.cmd` | `sync-dsh-profile.sh` | 一键同步插件声明、配置和 skills | 换机，或 A 机装完插件后 |

公共参数：

- `--dry-run`：只检查，不写文件、不安装（`pull-latest` / `upgrade-plugins` / `install-dshmarket`）。
- `pull-latest` 另支持 `--no-push`（不推送）、`--verify`（推送前跑本地 pre-push 类型检查，6–15 分钟）。
- `sync-dsh-profile` 支持 `export` / `apply` / `diff` 子命令，以及 `--force-skill <名称>`。

## 日常流程

日常：

```
1. pull-latest      拉代码 + 别人提交的插件基线
2. sync-dsh-profile 应用基线到本机（并导出本机新增内容）
3. pnpm start       构建并启动（需要时）
```

A 机装完新插件后：

```
1. upgrade-plugins（可选，升到最新）
2. sync-dsh-profile（自动导出基线、提交、推送）
3. 其他机器：pull-latest → sync-dsh-profile → pnpm start
```

只改代码：只跑 `pull-latest`。只改插件/配置/skills：只跑 `sync-dsh-profile`（它会自己 fetch 并快进 `origin/dev`）。

## pull-latest（拉取代码）

五步：

1. 拉取 `origin`；
2. 更新本地 `master` 指针（不切分支）；
3. 把 `dev` 快进到 `origin/dev`；
4. 拉取 `upstream` 并合并进 `dev`；
5. 检查 `master` 镜像，清理上游已删除包的残留目录。

之后：

- `pnpm-lock.yaml` 变化或清理过残留目录 → 自动 `pnpm install`；
- 有未推送提交 → 推送 `dev`；master 落后 → 同时快进镜像；
- 打印本地 `dev` / `master` 与 `origin` 的对照表。

冲突处理：

- 检测到 `MERGE_HEAD`（上次合并中断）会停下来，提示二选一：`git merge --abort` 后重跑（推荐），或冲突已解决时 `git commit --no-edit`。
- 如果合并冲突**全部是** `*.i18n.yaml` 配对记录，脚本会自动重录哈希并提交（配对文档本身若有冲突标记则停下）。
- 其他冲突（代码/测试等）停下等人工解决，不会自动覆盖。

注意：

- 工作分支始终是 `dev`；如果有未提交的已跟踪文件改动，会列出并中止（`git stash -u` 或提交后再跑）。
- 默认推送跳过本地 pre-push 检查（该钩子跑全量 typecheck，6–15 分钟无输出）；需要本地先跑时加 `--verify`。

## upgrade-plugins（升级插件）

对 `desktop`、`web` 分别执行 `pnpm update --latest`，打印每个插件升级前后版本。

然后检查每个插件的 `@deepseek-ai/dsh-*` peer 是否覆盖当前 dsh 版本：

- `*`、`workspace:*` 视为覆盖；
- 不覆盖时列出，并给出放行命令：

```bash
pnpm dsh plugin --profile <profile> allow-version <包>@<版本> --dsh-version <版本> --accept-risk
```

放行等于接受不兼容风险；能等作者更新就不要放行。

## install-dshmarket（插件市场）

对两个 profile：

1. 补 `pnpm-workspace.yaml` 的 `allowBuilds`（含 git 来源的 codeload URL）和 `minimumReleaseAgeExclude`；
2. 如果当前是 git 依赖，先移除；
3. `pnpm add dshmarket@<最新版本>`；
4. 打印实际生效版本。

npm 发布版不需要执行构建脚本，优先使用。

## sync-dsh-profile（跨机器同步）

只同步“声明”，不同步 `node_modules`、会话、凭据、存储数据。

同步范围：

| 内容 | 说明 |
| --- | --- |
| `profiles/<profile>/package.json` | `dependencies` + `dsh.profile.bundles` |
| `profiles/<profile>/pnpm-workspace.yaml` | `allowBuilds`、`minimumReleaseAgeExclude`、`overrides` |
| `profiles/<profile>/cordis.patch.yml` | 按 `id` 合并 |
| `~/.dsh/cordis.patch.yml` | 全局 patch，按 `id` 合并（`insert` 结构按内部 `id`） |
| `~/.dsh/skills/` | 整目录复制，排除缓存/虚拟环境 |

双击/执行默认执行一键同步：

1. 检查仓库状态，快进到 `origin/dev`；
2. 仓库基线合并到本机（冲突保留本机，改动前备份到 `~/.dsh/backups/profile-sync-*`）；
3. 本机状态合并导出到 `dsh-profile-baseline.json` 和 `dsh-skills/`；
4. 基线有变化时自动提交并推送 `origin/dev`；
5. 对改动过的 profile 执行 `pnpm install`。

合并规则：**保留合并**。

- 新增依赖 / bundle / patch 会加入；
- 同名依赖版本不同、同 `id` patch 配置不同 → 保留本机版本并打印冲突，不覆盖；
- 同名 skill 内容不同 → 保留本机，需要覆盖时加 `--force-skill <名称>`。

跨平台：

- `link:` 路径导出为 `link:${DSH_REPO}/...`，应用时还原为本机仓库路径；
- Linux 上遇到含 `cmd.exe` 的全局 patch 会警告（需按平台调整或禁用该条目）；
- 基线文件和 skills 用 git 同步，Windows/Linux 共用一份。

单步操作：

```bash
node sync-dsh-profile.mjs export   # 只导出本机
node sync-dsh-profile.mjs apply    # 只应用基线
node sync-dsh-profile.mjs diff     # 只看差异
```

## Linux 环境准备（Fedora / Kali / Rocky）

见「首次准备」。各发行版注意：

- Fedora / Rocky：`sudo dnf groupinstall "Development Tools"`，Node 用 nvm 或 NodeSource；
- Kali：`sudo apt install build-essential python3`，Node 用 nvm（NodeSource 不官方支持 Kali）；
- 三台都要求 Node ≥24.9（dsh 的 engines 要求）；
- 首次 `git push` 配置 HTTPS credential helper 或 SSH。

## 常见报错速查

| 报错关键字 | 含义 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `ERR_PNPM_IGNORED_BUILDS` | pnpm 拒绝执行未审查的构建脚本 | 运行 `install-dshmarket`；其他插件把包名加入该 profile 的 `allowBuilds` |
| `Plugin X@v is incompatible with dsh V` | 插件 peer 没覆盖当前 dsh | 运行 `upgrade-plugins`；仍不兼容再按输出的 `allow-version` 放行 |
| `minimumReleaseAge` | 新版本保护期未过 | 在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: [包@版本]` |
| 停在 `推送到 origin：…` 很久不动 | `--verify` 模式在跑本地全量 typecheck | 等它跑完；不加 `--verify` 时默认跳过 |
| `无法访问 GitHub` / `SSL routines` / `unexpected eof` | 网络、加速器或 TLS 问题 | 检查网络/加速器后重跑；push 失败可直接重试 |
| `MERGE_HEAD` 存在 / 合并中断 | 上次合并未完成 | `git merge --abort` 后重跑 `pull-latest`（推荐） |
| `Permission denied`（Linux `.sh`） | 没有执行权限 | `bash xxx.sh`，或 `chmod +x xxx.sh` |
| `node: command not found` | Node 不在 PATH | 用 nvm 安装/激活 Node ≥24.9 |
| `storage-domain ... incompatible` | profile 里残留旧版官方包 | 见下方「profile 版本残留」 |
| `Failed to load plugins` | 插件依赖链未激活 | 先看启动日志里被禁用的插件；常见根因是 profile 里旧版官方包 |

## profile 版本残留（storage-domain 类问题）

dsh 大版本升级后，profile 的 `node_modules` 里可能残留旧版官方包，被启动器判定不兼容后禁用，导致一串服务 pending（页面 `Failed to load plugins`）。

处理：

```bash
cd ~/.dsh/profiles/web
pnpm why @deepseek-ai/dsh-storage-domain
```

- 只是版本旧：把 overrides 对齐到当前源码版本（pnpm 11 的 overrides 在 `pnpm-workspace.yaml`），再 `pnpm install`；
- 插件本身不需要：移除对应 bundle/依赖（例如 `dsh-reading-collection`）；
- 实验插件（如 `cot-translation`）可在 `cordis.patch.yml` 里 `disabled: true`。

## PATH 维护备注（Windows）

2026-09-28 清理过一次系统 PATH：删除了 4 条畸形条目（一个孤立的 `"`、`%JAVA_HOME%\jre\bin"`、两条被截断的 `ram Files\...`）。

规律：**PATH 里的路径不要用引号包裹**，带引号的条目会让 MSYS(sh) 到 cmd.exe 的 PATH 转换失败，表现为 pre-push 钩子报 `'node' is not recognized`。

原始 PATH 备份在 `%USERPROFILE%\.dsh\backups\system-path-<时间戳>.txt`。

## 常用命令

```bash
# 当前 dsh 版本
pnpm dsh --version

# 升级某个 profile 的全部插件
cd ~/.dsh/profiles/desktop && pnpm update --latest

# 单独升级插件市场
cd ~/.dsh/profiles/desktop && pnpm add dshmarket@latest

# 查看 / 撤销版本豁免
pnpm dsh plugin --profile desktop version-exemptions
pnpm dsh plugin --profile desktop revoke-version <包>@<版本> --dsh-version <dsh 版本>
```
