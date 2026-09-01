# Git 工作流速查手册

> 适用仓库：`deepseek-harness`（fork 自 `deepseek-ai/deepseek-harness`）
> 远程说明：
> - `origin`   = 自己的 fork：`https://github.com/MrChenDev/my-deepseek-harness.git`
> - `upstream` = 上游：`https://github.com/deepseek-ai/deepseek-harness.git`

---

## 核心原则

> **master 永远只当"上游的镜子"** —— 只用它同步上游，永远不直接改它、不把自己的私有改动塞进去。
> 自己的改动全走 `dev` 分支。
> 做到这条，拉上游就永远不会冲突。

---

## ① 日常开发（自己的改动都提交到 dev）

```bash
git checkout dev              # 切到 dev 分支（本地还没有时，会自动从 origin/dev 创建）
# ……改代码……
git add .                     # 或 git add <具体文件>
git commit -m "改动说明"
git push origin dev           # 推送到自己的 fork
```

---

## ② master 同步上游最新

```bash
git checkout master
git fetch upstream
git pull upstream master      # 拉上游最新（master 干净 → fast-forward，不会冲突）
git push origin master        # 更新自己的 fork（可选）
```

---

## ③ 上游最新同步到 dev

```bash
git checkout dev
git merge master              # 把 master 最新合进 dev
git push origin dev
```

> **如果 merge 报冲突：**
> 1. 手动打开冲突文件，解决 `<<<<<<<` / `=======` / `>>>>>>>` 标记
> 2. `git add <冲突文件>`
> 3. `git commit`
> 4. `git push origin dev`

---

## ④ dev 的好改动合并回 master

```bash
git checkout master
git merge dev                 # 全量合并；只想挑几个提交用 git cherry-pick <commit-hash>
git push origin master
```

---

## ⑤ 给上游提合并请求（PR）

**网页方式：** 打开 `MrChenDev/my-deepseek-harness` → **New pull request** → 点 **compare across forks**：

- `base repository: deepseek-ai/deepseek-harness` → `base: master`
- `head repository: MrChenDev/my-deepseek-harness` → `compare: master`（或 `dev`）

**命令行方式：**

```bash
gh pr create --repo deepseek-ai/deepseek-harness \
  --base master --head MrChenDev:master \
  --title "改动标题" --body "改动说明"
```

---

## 常用速查

| 操作 | 命令 |
|------|------|
| 查看所有分支 | `git branch -a` |
| 新建并切换分支 | `git checkout -b <分支名>` |
| 从远程拉已有分支到本地 | `git checkout <分支名>` |
| 暂存未提交改动 | `git stash` → 之后 `git stash pop` |
| 丢弃某个文件的改动 | `git checkout -- <文件>` |
| 本地私有忽略项 | 写进 `.git/info/exclude`（不提交、永不冲突） |
| 查看远程信息 | `git remote -v` |
