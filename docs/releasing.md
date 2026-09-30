# 发布

发布由**标签**触发，只此一条路：推一个 `v*` 标签，Publish 工作流把它发到 npm 的可信发布
（Trusted Publishing）上，成功后自动建 GitHub Release。本机不需要任何 npm token，也没有
`workflow_dispatch` 入口——手动触发会在默认分支上跑，等于凭空指定一个版本发出去。

发一次版是两步：版本号提交走 PR 合进 main，再给合并后的那个提交打标签、只推标签（见「一次发布」）。

依赖与构建走 pnpm（`packageManager` 钉在 `pnpm@11.7.0`），发布链路上仍有两处是 npm：`npm view` 查线上
版本、`npm publish` 真发布——可信发布与 provenance 是 npm CLI 的能力，工作流里那两步没有换。

## 包名与 scope

本包叫 **`@he0119/dsh-session-manager`**。无 scope 的 `dsh-session-manager` 在 registry 上已经
存在（不属于本仓库），那个名字收不回来，所以发布必须带 scope。`@he0119` 是 npm 账号 `he0119`
的 **user scope**——它不需要单独注册，**第一次发布带该 scope 的包时自动建立**（`dsh-aperture`
是无 scope 的，所以那边没有这一层）。

带 scope 有两个连带约定，都写在 `package.json` 里，别漏：

- `publishConfig.access = "public"`：scoped 包**默认 restricted**，而 restricted 需要付费组织。
  工作流里另外显式写了 `--access public`，两处一致。
- `repository.url` 必须指向本仓库：`--provenance` 要求包元数据里的仓库与工作流所在的仓库一致，
  缺了或写错会在生成证明那一步失败。

## 首版是一次性例外：必须手动发

npm 的信任发布**没有 pending publisher**：包必须先在 registry 上存在，才能在包设置页登记
Trusted Publisher。也就是说 `@he0119/dsh-session-manager` 的**第一个版本发不出去**——标签推上去
会在 OIDC 换 token 那一步失败，这不是工作流写错了（上游一直在讨论要不要放开：
[npm/cli#8544](https://github.com/npm/cli/issues/8544)）。

所以第一次这样发，之后就再也不用碰本机的 npm 登录状态：

```sh
# 1) 手动发首版（同时也是 @he0119 scope 的创建动作）
npm login                      # 以 he0119 登录，需要 2FA
pnpm run build                 # lib/ 不进 git，先出产物
npm publish --access public    # 不加 --provenance：本机没有 OIDC，签不出证明
#    ↑ 发出去的就是 package.json 里那个版本：先 pnpm version 改号再发，
#      别用 npm publish 顺手发一个 git 里没有的版本

# 2) 去 npm 包设置页登记 Trusted Publisher（表格见下一节）
#    https://www.npmjs.com/package/@he0119/dsh-session-manager/access

# 3) 之后再发版就走标签（步骤见「一次发布」）：本地 npm 登录状态可以退出，CI 不再需要任何 token
```

首版手动发出来的那个版本没有 provenance 证明（`dist.attestations` 为空），后面的版本都有；
这是流程本身的代价，不是配置漏了。

## npm 侧的一次性登记

发布用 npm 的**可信发布**（Trusted Publishing）而不是长期 token——CI 里没有 `NPM_TOKEN` 可偷，
发布时会把 provenance 证明签好。代价是每个新包要在 npm 上登记一次，登记时要选「允许哪些动作」：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `he0119` |
| Repository | `dsh-session-manager` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | `npm publish`（界面上的名字；实际放行的是 `createPackage`） |

发新包或换工作流文件名时，要连 Allowed actions 一起核对。名字对不上（大小写、`.yml` 后缀、仓库
归属）会在 OIDC 换 token 那一步失败；动作没放行则在 PUT 那一步拿到
`403 ... OIDC permission denied for this action`——它出现在 OIDC 换 token **成功之后**，别当成
工作流或标签的毛病。`--provenance` 会一并附上构建来源证明，所以发布产物能追溯到具体的 commit
与工作流。

## 一次发布

main 只接受 PR（服务端那条 ruleset 见 [AGENTS.md](../AGENTS.md) 的 Git 一节），所以发布分两步：版本号
提交走 PR 合进 main，再给合并后的那个提交打标签、单独把标签推上去。

```sh
# 1) 版本号提交走 PR 合进 main。--no-git-tag-version 同时禁掉提交与标签（`pnpm version --help` 里写的就是
#    "Don't create a commit or tag"），所以它只改 package.json，提交得自己补一步，`-m` 在这个组合下不起作用。
#    工作目录必须是干净的，否则 pnpm version 会拒绝（ERR_PNPM_UNCLEAN_WORKING_TREE，未跟踪的新文件也算脏）。
pnpm version 0.2.0 --no-git-tag-version
git add package.json && git commit -m "chore(release): 0.2.0"
# ↑ 发布提交只动 package.json 这一个文件。pnpm-lock.yaml 不记录本包的版本号，因此不必跟着改；
#   pnpm version 只跑 preversion/version/postversion 三个钩子，不触发本包的 prepublishOnly（tsdown），
#   因此不会顺带构建。
git push origin HEAD:refs/heads/chore/release-0.2.0
gh pr create --base main --fill          # 单个提交，标题直接取提交信息
gh pr merge --rebase --delete-branch

# 2) 拉下合并后的 main，在**它**上面打标签，然后只推标签。
git fetch origin
git switch main && git merge --ff-only origin/main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0          # 只推标签：Publish 工作流接手

npm view @he0119/dsh-session-manager version   # 几分钟后确认线上的版本
```

`0.2.0` 也可以写成 `patch` / `minor` / `major`，由你决定升幅（见下）。发布提交的信息由上面那句
`git commit -m` 给出；`pnpm version` 自己的 `-m` 只在它代为提交时起作用，而 `--no-git-tag-version`
下它根本不提交。

合并方式用 **Rebase** 或 **Squash**：ruleset 要求线性历史，merge commit 会被拒。两者都会换掉提交
SHA，所以标签一律**合并之后**再打——在分支上打的标签会落在被丢弃的那个提交上，合并后 main 上再也
找不到它。

## Release 日志怎么分组

Release 条目里的变更列表由 GitHub 自动生成（`gh release create --generate-notes`），分节规则写在
`.github/release.yml`：💥 破坏性变更 / ⬆️ 依赖更新 / ✨ 新功能 / 🐛 修复 / 📖 文档 / 🧰 维护，
没命中的落进「🧰 其它改动」。

它**只认 label**——GitHub 没有「按约定式提交分组」这回事，所以补标签这一步由
`.github/workflows/autolabeler.yml` 做：release-drafter 的 autolabeler 读 PR 标题，按
`.github/autolabeler.yml` 里的正则打标签。因此 **PR 标题必须写成约定式提交**（`feat: …`、`fix: …`），
写成「修个 bug」只会进兜底那一节。

两个已知边界：fork 来的 PR 拿不到写权限，打不上标签；`chore!:` 这种同时命中破坏性变更与维护的标题，
落进哪一节由 `.github/release.yml` 里的**顺序**决定——它就是靠顺序把破坏性变更提到最前面的。

## 为什么标签要在本地打、且必须打在 main 顶端

GitHub 在 Release 页面建标签时，会把它落在**当刻 main 的 HEAD** 上——如果发布提交之后又合并了别的
改动，标签就指到跟版本号无关的提交上，发布证明（provenance）记的是一段包含杂项的区间。本地打标签
没有这个问题：标签落点是你自己指定的那个提交，`git tag -a v0.2.0` 打的就是刚合进 main 的那个版本
提交。

为了让这条规则可执行，Publish 工作流在发 npm 之前做三道硬校验，任何一道不过就**在 npm 之前失败**：

| 校验 | 挡下什么 |
| --- | --- |
| 标签指向的提交里 `package.json` 就是 `vX.Y.Z` | 标签打在版本提交**之后**的某个提交上 |
| 标签指向的提交是 `origin/main` 的祖先 | 标签打在没合进 main 的分支上 |
| 标签指向的提交仍**等于** main 顶端 | 版本号已被后续发布取代（发出去就是往旧版本上倒灌） |

「合并之后再打标签」这套天然满足三道：标签与版本号在同一个提交上，而这个提交就是 main 顶端——
刚合完 PR 就打标签，中间别插别的改动。

第三道意味着「一个标签对应一个提交」：**推完标签就别再往 main 推东西了**，否则要么校验失败，要么
你得确认那个新提交该不该进这一版。顺序上先推标签，再继续改代码。

第三道不过时把标签挪到正确的提交上，或者等下一次发布；第一、二道不过说明标签打错了地方，
`git push origin :refs/tags/v0.2.0` 删掉重打。

> 标签必须带 `v` 前缀且能解析成 `x.y.z`（可带预发布后缀，如 `v0.2.0-rc.1`），`v1.2` 这种会直接失败。
> 已在 npm 上的同版本会被识别为「已存在」并安全跳过（发布成功的那一刻 registry 上就能查到，
> 判断是可靠的）；这一步跳过时，Release 条目仍然会建出来。

## 版本号在哪、怎么算

**`package.json` 是版本号的唯一来源**，标签只是它的复述——工作流只核对、不改写。改动它的是
`pnpm version`，而提交与标签是分开的两步（`--no-git-tag-version` 只让它改号，见「一次发布」），所以
版本号与标签指着同一个提交这件事，靠的是「合并之后再打标签」这个顺序，不是靠工具顺手打上。

升幅由人决定（`pnpm version major|minor|patch|0.2.0`），**没有任何东西自动推算**。

0.x 阶段的约定是：**破坏性变更按 minor 升**（`feat!:` → `0.2.0` 而不是 `1.0.0`），到 1.0.0 时再
改回按 major 升。这个约定不写进任何配置，因为它就是一个人的判断。

## 发布前的包内容自检

`pnpm run check:package`（`scripts/check-package.mjs`）用 **npm 自己的打包器**（`npm pack --dry-run`）
核对四件事：运行期文件一个不少、`main`/`types`/`exports`/`dsh.bundle.patch` 指向的路径都在包里、
产物内部的相对 import（tsdown 抽出来的带哈希 chunk）没指到包外，`src/`、`test/`、`docs/`、
`scripts/`、`.github/` 与 `tsconfig*` 都没有外泄；外加一条跨文件不变式——`cordis.patch.yml` 里
insert 的 `name` 必须等于 `package.json` 的包名。

它复述的是 npm 的打包规则里**最容易被误以为不需要检查**的那部分：入口指着一个没被打进包的文件，
本地测试全绿、装进宿主才报错。CI 与 Publish 都会跑它，所以它对发布是硬门禁。

⚠️ 它必须在 `build` 之后跑（`lib/` 不进 git）；脚本自己也要求这样，产物不存在时会以「缺少运行期文件」
的形式失败，而不是假装通过。

## 工作流一览

- `.github/workflows/ci.yml`：PR、推 main 时跑 `typecheck` / `build` / `check:package` / `test`
  （Node 22.19.0，与本包 `engines` 的下限一致；`check:package` 排在自己构建出产物之后）。
- `.github/workflows/publish.yml`：推 `v*` 标签时先复用一遍上面的检查，再依次做三道落点校验、
  打包自检、发布到 npm、建 Release。发布 job 里额外跑一次 `pnpm install --frozen-lockfile`，
  因为 `lib/` 靠 `prepublishOnly` 现场编译，而 check job 的依赖不跨 job 共享。
- `.github/workflows/autolabeler.yml`：PR 打开 / 重开 / 更新时按标题补标签，供
  `.github/release.yml` 给 Release 日志分组（fork 的 PR 打不上标签）。
