# Agent Note: 有损的 projectKey 会撞名，动手前先查

Status: implemented

## Problem

`projectKey` 把 `/`、`\`、`:` 折叠成 `-` 并截断到 251 字符，所以 `C:\x\y` 与 `C:\x-y` 编码结果
**相同**——两个不同的工作目录会落到同一个项目目录上。

宿主的 `realpath` 唯一性检查抓不到这种碰撞：两个 `path` 字符串确实不同，是**编码**把它们变成了一样
的东西。

## Decision

计划层在动手前显式检查源与目标项目目录名是否相同，冲突就拒绝；`detectProjectKeyCollision()` 作为
通用工具暴露，让这条判据只有一处实现。

## Alternatives considered

**依赖宿主的 `realpath` 唯一性检查。** 它检查的是两个工作区的 `path` 是否指向同一处，而这里的问题
是两条不同的 `path` 编码到了同一个目录名——它看不见。

**碰撞时就地合并（把两个目录的会话放进同一个项目目录）。** 那等于让宿主的 `projectKey(header.cwd)`
校验在加载时抛错，而且是把两份原本分开的会话混在一起——比拒绝执行糟得多。

**截断得更短以免撞名。** 截断不是碰撞的原因，折叠 `/` 与 `-` 才是；缩短文件名只会让碰撞更早出现。

## Consequences

- 碰撞被当成一次**计划层**的拒绝，附带两个撞在一起的路径，而不是执行到一半才发现。
- `test/project-key.test.ts` 对着宿主的 `projectKey` / `encodeSegment` 逐字节比对，并钉住碰撞确实
  存在——判据不能只在文档里成立。
