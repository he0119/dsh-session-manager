# 开发

安装与用法看 [README](../README.md)，「为什么是现在这样」看 [internals.md](internals.md)。

## 依赖、构建、测试

本包运行时只有一个依赖（`fzstd`，纯 JS 的多帧 zstd 解码器）。

```sh
pnpm install          # 或 npm install（本机请用 npm，见「本机安装」）
pnpm run build        # tsdown：src/*.ts -> lib/*.js + lib/types/*.d.ts
pnpm test             # = node test/run-all.mjs
pnpm run typecheck    # = tsc -p tsconfig.test.json
pnpm run check        # typecheck + test
```

带真实数据回归（指向任一含会话桶的 `sessions/` 备份目录）：

```sh
DSM_FIXTURE=/path/to/backup pnpm test
```

没设 `DSM_FIXTURE` 时，`test/real-data.test.ts` 会整组跳过（这是 runner 里那 1 个 `skipped`）。

### 构建产物冒烟（`test/artifact.test.mjs`）

其余测试都直接 import `src/*.ts`，所以**「源码通过」不等于「产物能装进宿主」**。
`test/artifact.test.mjs` 加载 `lib/index.js`（`package.json` 的 `main`），断言：

- 入口自描述字段与 `cordis.patch.yml` / `inject` 一致（`name`、`inject: ['tools']`）
- 能注册出 4 个工具，且 `parameters` / `output.render` 形状符合宿主契约
- `apply()` 返回**单个**卸载函数（Cordis 契约：不是 disposer 数组），调用后不抛

它写成 `.mjs` 而非 `.ts`：要加载 `lib/` 里的产物，用 `.ts` 会让 `tsc` 去解析产物路径。
产物不存在时整组跳过，所以源码开发不必先构建；`pnpm run build && pnpm test` 才是全绿口径。

真实数据那一条额外用环境变量门控（同样默认跳过）：

```sh
DSM_SMOKE_WORKSPACE=/path/to/a/real/workspace pnpm test
```

它会在这个目录上跑一次只读 `plan`，并断言计划自己算出的 `targetBucket` 目录**没有被创建**
——把「只读」从口头承诺变成可断言的事实。目标桶名取自计划返回值，不硬编码。

### 本机安装（Windows 沙箱下的实测结论）

pnpm 的 isolated 布局在本机**不可用**：它生成的 junction 目标畸形
（`Global\C:\…`，`fs.realpathSync` 也解析不出来），于是运行时报

```
Cannot find package '@deepseek-ai/cosmokit' imported from …/cordis/lib/index.js
```

尽管 `.pnpm/…/node_modules` 下确实链接了它。`pnpm-workspace.yaml` 里写了
`node-linker: hoisted` 想改成扁平真实目录，但**本机 pnpm 会忽略它**
（`pnpm config get node-linker` → `undefined`，在一个只放 `.npmrc` 的干净临时目录里也一样）。
所以这台机器上请用 npm，它天生是 hoisted 的真实目录：

```sh
npm install --no-package-lock --no-audit --no-fund --cache ./.npm-cache
```

`--no-package-lock`：本仓库的锁文件是 `pnpm-lock.yaml`，不要让 npm 另写一份。
`--cache ./.npm-cache`：**沙箱下必需**。npm 默认把缓存与日志写到
`%LOCALAPPDATA%\npm-cache`，那在工作区之外，会被沙箱拒绝：

```
npm error The operation was rejected by your operating system
Log files were not written due to an error writing to the directory: C:\Users\…\npm-cache\_logs
```

把缓存重定向进工作区即可（`.npm-cache/` 已在 `.gitignore` 里）。
Linux/CI 上 symlink 正常，用 `pnpm install` 走 `pnpm-lock.yaml` 即可。

### 为什么测试不用 `node --test`

`node --test` 会为**每个测试文件** spawn 一个子进程（piped stdio）。在 DSH 的 Windows 沙箱下，
子进程无法通过命名管道捕获输出，于是必然 `spawn EPERM`——**与测试内容无关**。

`test/run-all.mjs` 在同进程内依次 `import` 各测试文件：`node:test` 在直接运行该模块时同样会注册并
执行用例，只是不再经过子进程隔离。代价是某个文件抛错会影响同进程的其它文件，因此 runner 对每个文件
单独 try/catch 汇总。

`pnpm run test:runner`（即 `node --test`）保留给不受此限制的环境；CI 上跑的是 `pnpm test`。

### 工具层测试怎么拿到真实的 `dsh-tools`

`@deepseek-ai/dsh-tools` 是宿主的 peer 依赖，但仓库把它**同时列为 devDependency**，所以装了依赖之后
`src/tools.ts` 的 `import '@deepseek-ai/dsh-tools'` 直接解析得到真实实现——`test/tools.test.ts`
因此能断言真正的工具注册契约（schema 归一化、实参校验、render），而不是走桩。

## 结构

```
src/            手写源码（每个文件一个职责，核心层零 DSH 依赖）
  index.ts        插件入口（挂 tools）
  cli.ts          离线 CLI（构建出 lib/cli.js，package.json 的 bin 指向它）
  tools.ts        4 个工具 + schema
  ...             核心层：project-key / paths / zstd-frame / session-log /
                  discovery / registry / artifacts / plan / journal / execute
lib/            构建产物（tsdown 输出，已 gitignore）
scripts/        安装器等一次性工具
test/           测试（run-all.mjs 是进程内 runner）
docs/           本目录
tsdown.config.ts 两份构建配置：host（lib/*.js）与 types（lib/types/*.d.ts）
cordis.patch.yml 插件注册（package.json 的 dsh.bundle.patch 指向它）
```

核心层（`project-key` / `paths` / `zstd-frame` / `session-log` / `discovery` / `registry` /
`plan` / `journal` / `execute` / `artifacts`）**不依赖 DSH**，所以插件外壳、CLI 与测试三者共用
同一段代码。只有 `src/tools.ts` 与 `src/index.ts` 依赖 `@deepseek-ai/dsh-tools`。

`lib/` 是产物不是源：改代码改 `src/`，`pnpm run build` 重新生成；`lib/` 不进 git。

### tsconfig 上的一处刻意偏离

`noUncheckedIndexedAccess` 关掉了（`tsconfig.json` 里有注释说明）。本项目大量代码是
「按已知长度切 buffer / 按已知形状读 JSON 字段」，开启后会在几十处纯噪音的位置要求非空断言，
反而掩盖真正需要检查的 `undefined`。其余 strict 家族全开。

## 装进一个 profile

```sh
node scripts/install.mjs           # dry-run：只打印会改什么
node scripts/install.mjs --apply   # 复制包 + 加 dsh.profile.bundles，然后重启 DSH
```

或走宿主的标准安装：

```sh
npx @deepseek-ai/dsh@next plugin --profile <name> add <本目录>
```

不要用日常在用的实例做开发验证：照 [README](../README.md) 的方式另建一个开发 profile
（`dsh <name>` 就是 `dsh --profile <name>`），在另一个端口上起它。Host 端改动必须**重启**才生效。

## 改动后至少跑什么

```sh
pnpm run check        # 类型 + 测试
pnpm run build        # 确认产物能出来（构建不做类型检查，所以两件事都要做）
```

涉及工具契约的改动，另外跑 `test/tools.test.ts` 那组；涉及帧/压缩的改动，
`test/zstd-frame.test.ts` 里有一条专门的回归防线（`assertMultiFrameAware`
拒绝「只解首帧」的解码器——这正是当初造成数据截断的那个坑）。
