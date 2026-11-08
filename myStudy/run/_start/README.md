# DSH 日常脚本说明（myStudy/run/_start）

本目录存放我在本机和公司电脑上双击使用的脚本。它们随 git 仓库同步：换机器后先双击 `pull-latest.cmd` 拿到最新版本，其余脚本就都在了。所有脚本都是幂等的，可以重复运行。

## 脚本清单

| Windows | Linux（Fedora/Kali/Rocky） | 作用 | 什么时候用 |
| --- | --- | --- | --- |
| `pull-latest.cmd` | `pull-latest.sh` | 拉取上游、同步 dev 与 master 镜像、自动 push | 每次上游有新提交时 |
| `upgrade-plugins.cmd` | `upgrade-plugins.sh` | 把两个 profile 的插件升到最新，并检查与当前 dsh 是否兼容 | dsh 升级后，或插件报"不兼容"时 |
| `install-dshmarket.cmd` | `install-dshmarket.sh` | 安装或升级 `dshmarket`（插件市场）到两个 profile | 新机器上第一次装插件市场时 |
| `sync-dsh-profile.cmd` | `sync-dsh-profile.sh` | 一键同步插件声明、profile 配置和 skills（应用基线 + 导出本机 + 提交推送） | 换机，或 A 机装完插件后 |

Windows 双击 `.cmd`，Linux 执行同名的 `.sh`；两个入口都调用同一份 Node 逻辑（`.mjs`），行为一致。旧的 `.ps1` 保留但已不再被入口调用。公共参数：`--dry-run` 只检查不写入；`pull-latest` 另支持 `--no-push`、`--verify`。

## pull-latest.cmd（拉取最新代码）

依次执行五步：拉取 `origin`、更新本地 `master` 指针（不切分支）、把 `dev` 快进到 `origin/dev`、拉取 `upstream` 并合并进 `dev`、检查并快进 `master` 镜像；随后在 `pnpm-lock.yaml` 变化**或刚清理过残留目录**时自动 `pnpm install`，最后把 `dev`（以及需要更新的 master 镜像）推送到 origin。

第 5 步同时清理“上游已删除包”留下的残留目录（无 `package.json`、只含 `lib`/`node_modules` 等构建产物的 `packages/<组>/<包>` 目录）。上游搬包后旧路径的 `lib/` 还在，构建会照着旧代码去要已删除的导出，报 `MISSING_EXPORT`；清理后必须重装依赖，否则 `node_modules` 里的链接仍指向旧路径。留着 `package.json` 的目录只列出、不删除。

`pnpm start`（`scripts/start.ts`）在构建前会跑同一套清理（`scripts/stale-package-residue.ts`）：删掉残留后自动 `pnpm install` 刷新指向旧路径的链接，再开始构建，所以即使没走这一步、或残留从别的途径留下，构建同样能自愈。

结尾会打印本地 `dev` / `master` 与 GitHub fork 的对照表：`与远端一致` 表示同步完成，`领先远端 N 个提交` 表示本地有新提交（脚本会尝试推送），`落后` 或 `分叉` 表示需要人工处理。

注意两点：脚本只处理 `dev` 和 master 镜像，工作分支始终是 `dev`；如果有未提交的已跟踪文件改动，它会列出文件并中止，处理方式是把改动提交或用 `git stash -u` 暂存。

推送默认跳过本地的 `pre-push` 检查（该钩子只跑一条 `pnpm run typecheck`：全量类型检查，通常 6–15 分钟，期间终端不输出任何东西，看起来像卡住）。跳过之后推送只花几十秒，GitHub CI 仍会跑完整门禁；想在本地先跑检查时用 `pull-latest.cmd -Verify`，脚本会先打印"正在跑本地 pre-push 类型检查"再推送。

## upgrade-plugins.cmd（升级插件）

对 `desktop` 和 `web` 两个 profile 各执行一次 `pnpm update --latest`，然后打印每个插件升级前后的版本（绿色表示升级了，灰色表示已是最新）。

接着检查每个插件声明的 `@deepseek-ai/dsh-*` peer 是否覆盖当前 dsh 版本：全部覆盖时提示"所有插件的 peer 声明都覆盖当前 dsh 版本"；有插件没覆盖时，列出该插件并打印可复制的放行命令 `pnpm dsh plugin --profile <profile> allow-version <包>@<版本> --dsh-version <版本> --accept-risk`。

放行等于明确接受"插件可能与当前 dsh 不兼容，运行它可能导致崩溃或数据丢失"的风险，能用"等插件作者发布新版本"解决就不要放行。完成后重启桌面端或重启 Web 即可。

## install-dshmarket.cmd（安装插件市场）

对 `desktop` 和 `web` 两个 profile：补齐 `pnpm-workspace.yaml` 里的 `allowBuilds`（Git 来源的包需要执行构建脚本）与 `minimumReleaseAgeExclude`（放行刚发布的新版本）；如果发现已装的是 Git 依赖，先移除再安装 npm 版；最后打印两个 profile 里实际生效的版本。

安装 npm 发布版可以完全避开"包需要执行构建脚本"的报错，所以优先用它。命令等价于在 profile 目录执行 `pnpm add dshmarket@<最新版本>`。

## sync-dsh-profile.cmd（跨机器同步插件与配置）

把本机 `~/.dsh` 里的插件声明、profile 配置和 skills 同步到仓库，或从仓库合并到本机。只同步声明，不同步 `node_modules`、会话、凭据和存储数据。

同步范围：

- `profiles/web|desktop/package.json`：`dependencies` 和 `dsh.profile.bundles`
- `profiles/web|desktop/pnpm-workspace.yaml`：`allowBuilds`、`minimumReleaseAgeExclude`、`overrides`
- `profiles/web|desktop/cordis.patch.yml`：按 `id` 合并
- `~/.dsh/cordis.patch.yml`：全局 patch，按 `id` 合并（`insert` 结构按内部 `id`）
- `~/.dsh/skills/`：整目录复制（排除 `__pycache__`、`*.pyc`、`.venv`、`node_modules` 等）

双击默认执行**一键同步**，不需要选菜单：

1. 检查仓库状态，快进到 `origin/dev`；
2. 把仓库基线合并应用到本机（冲突保留本机版本并报告，改动前自动备份到 `~/.dsh/backups/profile-sync-*`）；
3. 把本机状态合并导出到 `dsh-profile-baseline.json` 和 `dsh-skills/`；
4. 基线有变化时自动提交并推送到 `origin/dev`；
5. 对改动过的 profile 自动执行 `pnpm install`，完成后直接 `pnpm start` 即可。

需要单独操作时也可以指定模式：`export`（只导出）、`apply`（只应用）、`diff`（只看差异，不写文件）。

`link:` 路径用 `${DSH_REPO}` 占位，应用时按本机仓库路径还原，所以 Windows 和 Linux 可以共用同一份基线。

Linux 上执行：`node myStudy/run/_start/sync-dsh-profile.mjs`（也可加 `export` / `apply` / `diff`）。同名 skill 内容不同时，加 `--force-skill <名称>` 才会用基线覆盖本机。

## 日常标准流程

```
1. 双击 pull-latest.cmd        拉上游 + 同步 master 镜像 + 自动 push
2. 双击 upgrade-plugins.cmd    dsh 更新后跑一次；插件报错时也跑它
3. 重启桌面端（或 pnpm dsh web）
4. pnpm start                  在仓库根目录运行：需要时先构建，然后启动
```

两个 profile 相互独立：`desktop` 供桌面端使用，`web` 供 Web 端使用，插件要各自安装、各自升级。

## 常见报错速查

| 报错关键字 | 含义 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 或 `ERR_PNPM_IGNORED_BUILDS` | pnpm 拒绝执行未审查的构建脚本 | 双击 `install-dshmarket.cmd`；其他插件则把包名加进该 profile 的 `allowBuilds` |
| `Plugin X@v is incompatible with dsh V` | 插件版本没覆盖当前 dsh 版本 | 双击 `upgrade-plugins.cmd`；仍不兼容时按它打印的 `allow-version` 命令放行 |
| `minimumReleaseAge` | 新版本保护期未过 | 在该 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: [包@版本]` |
| `pre-push 钩子环境不可用，改用 --no-verify 推送` | 本机 PATH 被破坏，钩子里的 node/npm 找不到 | 检查系统 PATH 是否又出现带引号的条目（见下节） |
| 停在 `推送到 origin：…` 很久不动 | 只在 `-Verify` 模式下会发生：本地 `pre-push` 全量类型检查在跑，期间无输出 | 等它跑完；默认模式已跳过该检查，推送只需几十秒 |
| `无法访问 GitHub` | 网络或加速器问题 | 打开加速器后重跑脚本 |

## PATH 维护备注

2026-09-28 清理过一次系统 PATH：删除了 4 条畸形条目（一个孤立的 `"`、`%JAVA_HOME%\jre\bin"`、两条被截断的 `ram Files\...`）。这些条目不会被任何程序解析到，删除后不影响 Java、TortoiseGit 等工具的使用。

规律：**PATH 里的路径不要用引号包裹**，带引号的条目会让 MSYS(sh) 到 cmd.exe 的 PATH 转换失败，表现为 pre-push 钩子报 `'node' is not recognized`。

清理前的原始 PATH 备份在 `%USERPROFILE%\.dsh\backups\system-path-<时间戳>.txt`，同目录的 `system-path-<时间戳>-restore.ps1` 可以在管理员权限下把它还原。

## 常用命令

```powershell
# 当前 dsh 版本
pnpm dsh --version

# 单独升级插件市场（desktop / web 各执行一次）
cd "$env:USERPROFILE\.dsh\profiles\desktop"; pnpm add dshmarket@latest

# 升级某个 profile 的全部插件
cd "$env:USERPROFILE\.dsh\profiles\desktop"; pnpm update --latest

# 查看 / 撤销版本豁免
pnpm dsh plugin --profile desktop version-exemptions
pnpm dsh plugin --profile desktop revoke-version <包>@<版本> --dsh-version <dsh 版本>
```
