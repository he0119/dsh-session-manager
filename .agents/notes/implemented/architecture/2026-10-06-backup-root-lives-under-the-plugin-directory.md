# Agent Note: 备份根落在插件自己的目录下

Status: implemented

## Problem

本插件往 `$DSH_HOME` 里写的东西只有一样：迁移 / 删除 / 同步覆盖前的字节级备份（见
[删除先备份](2026-09-28-delete-backs-up-and-spares-the-registry.md)）。这些备份是回滚的唯一凭据，
所以它们放在哪、以及**改了默认位置之后老备份还找不找得到**，都是对外契约的一部分，而不只是一个
目录名。

默认位置原本是 `<DSH_HOME>/dsh-session-manager-backups`——一层平铺的名字，和同一台机器上别的插件
（`dsh-config-manager/snapshots`、`dsh-config-manager/transactions`）放在一起看，`$DSH_HOME` 根下
会多出一层只属于某一个插件的名字，读起来像是"这个家目录的备份"，而不是"这个插件的备份"。

麻烦的是改默认值这件事本身。清单只读 `backupRoot` **一个**根（`listBackups()`），而回滚前那道越界
检查只认备份根下的路径（`src/migrate.ts` 的 `assertBackupDir()`：回滚会按清单里的路径搬目录、写注
册表，等于"以清单为准的任意写"，所以界面能传的字符串只换来自己写过的那棵子树）。于是"只改默认值"
会让已经写好的备份同时从列表里消失、也没法按路径滚回去——等于把回退凭据锁在门外。

## Decision

- 默认备份根是 **`<DSH_HOME>/dsh-session-manager/backups`**，与 `dsh-config-manager` 那种
  "插件名 / 子目录"同一形状。另外两个默认路径（`sessions`、`storages/workspace.json`）不动：它们是
  宿主的目录，本插件只是读。
- 旧位置由插件在 `apply()` 里**整体搬一次**（`src/tools.ts` 的 `adoptLegacyBackupRoot()`）：三个条件
  同时成立才动——用户没自己配 `backupRoot`（配了就按他说的来）、旧目录在、新目录不在。整个 `rename`
  在同一个 `$DSH_HOME` 下是原子的，清单字节不动（里面记着回滚要还原的原位）。
- 搬不动就**原地不动并如实报错**（日志里给出两个路径与原因）：备份是回滚的唯一凭据，宁可不搬，也不能
  搬一半。启动不因此失败——备份目录不是会话库，没有"启动不变式"那类硬失败的理由。

## Alternatives considered

**只改默认值，旧目录留在原地。** 改动最小，但老备份既列不出来（列表只读一个根）也回滚不了（越界
检查拦下），用户得自己 `mv` 一次才知道该放哪。

**列表与回滚同时认两个根。** 不动磁盘，代价是把"备份根"从一个值变成两个值：`listBackups()` 要去重
合并，`assertBackupDir()` 要接受两棵子树，`backupRoot` 这个对外字段的语义也跟着含糊。一次搬迁的复杂度
换掉一份长期的复杂度，不划算。

**搬迁时把两个根合并（新根已存在也搬）。** 两边各自的清单可能指向同一批会话，谁覆盖谁没有确定答案；
分不出对错的合并宁可不做。

**在 `resolvePaths()` 里顺手搬。** 那是个纯函数，被工具、界面、测试反复调用（每次调用都写盘），而
"每次读路径都可能改磁盘"是最难排查的一类副作用。搬迁只在 `apply()` 里发生一次。

## Consequences

- **旧备份继续可用**：升级后第一次启动，`~/.dsh/dsh-session-manager-backups` 整体出现在
  `~/.dsh/dsh-session-manager/backups`，界面里的备份清单与按路径回滚都不受影响。
- 冒烟测试 `test/artifact.test.mjs` 会真的 `apply()` 一次插件，因此它现在把 `DSH_HOME` 指向一座临时
  目录——跑测试不该拿运行者真实的 `~/.dsh` 当场地。
- `test/backup-root.test.ts` 钉默认路径的字面值，以及搬迁的四个分支（正常搬迁、没旧目录、新根已在、
  搬不动）：把默认值改回去、或者去掉"新根已存在就不动"这一条，这几条断言都会变红。
