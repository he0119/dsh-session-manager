# dsh-session-manager

Migrate DSH workspaces and sessions to a new directory: rewrite session-log `cwd`, move the log
directories, re-home workspace membership, and optionally move the files those sessions created.

[中文](README.md) | English

> **Status**
> - ✅ Core library, migration engine, offline CLI, plugin shell and 4 tools
> - ✅ Session management: one page in Settings (`settings.section`, with import/export and migrate
>   tabs) plus 6 endpoints under `/dsh-session-manager/api`
> - ✅ Tool contract verified against the **real `@deepseek-ai/dsh-tools`** (`defineTool` normalization
>   + argument validation + real execution)
> - ✅ Session-artifact migration: evidence layering + on-disk intersection + nested pruning, rolled
>   back together with the sessions
> - ✅ Source is TypeScript: `src/*.ts` → tsdown → `lib/` (build output, not committed); `tsc` typecheck
>   and the build both pass
> - ✅ **97 of 99 tests pass** (real log files, real registry, end-to-end byte-level rollback assertions,
>   and a built-artifact smoke test)
> - ⏳ Pending your go-ahead: install into a profile and restart DSH to load the 4 tools and open that
>   settings page for real (the page's styling is verified at build/artifact-contract level only — it
>   has not been looked at in a live GUI yet)

## The problem it solves

In DSH, "which workspace a session belongs to" is **not** an editable field — it is derived from the
`cwd` in the session log header:

- The host derives the log directory from `projectKey(cwd)`:
  `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`
- On load it verifies "the bucket the file lives in == `projectKey(header.cwd)`"; a mismatch throws
  `corrupt session log ... header id and cwd identify ...` (**a hard failure**)
- The `@deepseek-ai/dsh-workspace` README states plainly that "sessions from other directories cannot
  be moved in", and the public API (`create/get/list/delete/insertBefore/archiveSession/resolveByPath`)
  has **no reassign / move** at all

So a migration must do three things consistently: **rewrite the header `cwd` + move the log directory
+ update the workspace ledger**.

## Usage

### CLI (offline, usable today)

```bash
pnpm install && pnpm run build    # source is TypeScript; the CLI is built to lib/cli.js

# Read-only plan: writes nothing
node lib/cli.js plan   --from '<source dir>' --to '<target dir>'

# Execute: byte-level backup first, then rewrite the first frame, move dirs, write the registry
node lib/cli.js apply  --from '<source dir>' --to '<target dir>'

# Verify: every log in the target bucket agrees with its header cwd
node lib/cli.js verify --to '<target dir>'

# Roll back: move dirs back + restore file bytes + restore the registry
node lib/cli.js rollback --backup '<backup dir printed by apply>'
```

Once installed you can also use the bin shim (`dsh-session-manager plan …`).

Defaults are `$DSH_HOME/sessions` and `$DSH_HOME/storages/workspace.json`; override with `--root` /
`--registry` / `--backup`. `plan` exits 2 when there are problems and never writes.

### Plugin tools (callable by the model)

| Tool | Writes | Purpose |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session/file counts, target bucket, ledger change, blockers |
| `migrate_sessions` | needs `apply:true` | Dry-run by default; performs a byte-level backup and self-verifies after |
| `rollback_session_migration` | yes | Byte-exact rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that a directory's bucket agrees with its headers |

### Session management (Web UI)

Once installed into a profile, the **Settings** sidebar gains a **Session management** page (this
package ships a Web Client half) with two tabs:

**Import & export** (take sessions away, bring them back)

- **Export**: tick sessions → the browser downloads one `.dhsess` bundle. The bundle carries the raw
  bytes of **every generation** of those logs (each with a sha256), not files the session created.
- **Import**: pick a bundle and a target workspace → **preview first** (per-session: what will be
  created, which cwd gets rewritten, what is skipped, how the registry changes) → then confirm. Import
  **never overwrites**: a session whose id already exists in the library is skipped and reported; a
  session with no cwd lands in the `_no-cwd` bucket and is not ledgered.

**Migrate** (move one workspace's sessions to another directory)

Previously CLI- and tool-only, now the same orchestration (`src/migrate.ts`, shared by all three entry
points) is on screen:

- source and target are each a **single dropdown that holds the value** (registered workspaces **plus any
  directory the library actually holds sessions for**, annotated with that count), so no path has to be
  typed from memory; a path outside the candidates goes in through **Browse…** or **Type a path**, and is
  added back as a row. **Browse…** follows whatever capability the host serves: on the desktop it opens the
  OS directory dialog, in the browser it expands an in-page directory browser (list subdirectories, click
  your way down), and on a host with no picker the button is simply not shown;
- the target directory must already exist; there is also an optional title for a newly created workspace,
  whether to carry the **files the sessions created**, and whether to carry unregistered sessions;
- **move the whole source directory, or only some of it**: the sessions of the source directory are
  listed, and ticking any row switches to "only the ticked ones"; one source directory per run (one
  request, one bucket);
- **Preview**: session, log and byte counts, source → target bucket, **how the ledger changes** (create
  or reuse the target workspace, how many sessions are added, which workspaces lose them, whether an
  emptied workspace is removed), the artifact plan and its skip reasons;
- **Migrate now**: rewrite each log header `cwd` (first frame only, the rest byte-identical) → move the
  session directories → re-home the ledger → **independent verification** (the host's own corrupt
  criterion) → leave a byte-level backup;
- **Backups & rollback**: every backup this plugin wrote (time, session count, source → target), with
  the **rollback steps** shown before you confirm; rollback restores directories, log bytes and the
  ledger together (and removes the emptied target bucket, symmetric with the migration cleaning up an
  emptied source bucket).

The endpoints live under `/dsh-session-manager/api` (`state` / `export` / `import` / `migrate` /
`backups` / `rollback`) and all writes happen inside the host process. A profile without the
`webServer` service (tools-only front ends) still loads the plugin — the page simply does not appear.
See [docs/internals.md](docs/internals.md) for the bundle shape and the invariants it enforces.

### When it takes effect (dual mode)

`workspaceRegistry` holds an **in-memory** registry plus a header index, and the method that rebuilds
that index (`replaceHeaderIndex`) is private. Therefore:

- if the upstream host exposes `workspaceRegistry.reassignSessions()` → `effectMode()` detects it and
  the migration takes effect immediately;
- otherwise the on-disk write is correct but **DSH must be restarted** for it to be acknowledged.

The `takesEffect` field in every tool result reports which mode you are in, instead of pretending it
is immediate.

## Installing into a profile

From npm (recommended):

```bash
# DSH's own plugin command (it creates/populates the profile and maintains deps + lockfile)
npx @deepseek-ai/dsh@next plugin --profile desktop add @he0119/dsh-session-manager
# then restart DSH
```

From this checkout while developing (`lib/` is not committed, so build first):

```bash
pnpm run build
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-manager
# then restart DSH
```

Note that `github:` installs are **not** supported here: those build via a `prepare` script, while this
repository builds in `prepublishOnly` and keeps `lib/` out of git, so a git install gets no artifacts.

Mechanism: `profiles/<name>/cordis.yml` is an empty `[]`; the tree is composed from
`package.json`'s `dsh.profile.bundles` (each bundle contributes its own `cordis.patch.yml`), then the
profile's own `cordis.patch.yml` (id-targeted overrides), then `--patch` overlays. So installing means:
put the package in `node_modules` and add its name to `dsh.profile.bundles`.

`--profile <name>` picks the target profile (`dsh <name>` is shorthand for `dsh --profile <name>`).
**Do not use your daily instance for development checks** — make a separate dev profile and start it on
another port (see [docs/development.md](docs/development.md)).

## Session artifacts (optional)

With `includeArtifacts` enabled, the plugin reconstructs "which files this session created" from the
logs and moves them along. Evidence is **layered**:

| Evidence | Strength | Meaning |
|---|---|---|
| `write` tool `file_path` | authoritative | created |
| `deliverables/presented` | authoritative | deliberately delivered |
| `edit` tool `file_path` | authoritative | **modified** (not created; moved by default, exclude via `includeKinds`) |
| creation paths in `pwsh`/`bash` commands | heuristic | counted only when a creation verb is present |

Two narrowings are mandatory, or the plan is unusable:

- **intersect with on-disk existence** — of 51 candidates measured, 39 had already been deleted by the
  session itself;
- **prune nesting** — when a directory is moved wholesale, files inside it are not moved again.

Artifacts share the same backup manifest, so `rollback` restores them byte-for-byte too.

> Note: extraction requires **decoding the whole log** (all frames), far slower than the
> header-only discovery pass, so it only happens when explicitly requested.

## Key design constraints

### 1. Multi-frame zstd: only multi-frame-aware decoders

The host appends one flush per event, so a `.zstd` on disk is a **concatenation of frames** (measured:
up to thousands per file). `node:zlib`'s `zstdDecompress(Sync)` / `createZstdDecompress` **decodes only
the first frame and silently drops the rest**, without even reporting truncation — decoding just the
first frame leaves only the session header line, making the whole session look empty.

The plugin never picks a decoder itself; the caller injects one, and `assertMultiFrameAware()` **probes
it at startup** (two raw frames, expecting `"AB"` back). A regression test feeds it `node:zlib` to prove
the guard actually rejects it.

### 2. Only the first frame is rewritten

Only the **first frame** is recompressed; every remaining frame is kept byte-identical. The result
matches the host's own multi-frame layout, and the tail is auditable — the end-to-end test compares line
by line and asserts a byte-exact restore after rollback.

The frame boundary is not found by guessing magic bytes; it uses a self-consistency criterion: the
smallest offset `i` where `decodeAll(buf[0..i)) + decodeAll(buf[i..)) === decodeAll(buf)` and the head
ends on a newline.

### 3. Zero-dependency write path

`fzstd` only decompresses; `node:zlib`'s built-in zstd has a Node version floor. So `encodeRawFrame()`
hand-writes a valid zstd frame containing a single **raw (uncompressed) block** (Single_Segment=1,
Block_Type=Raw), making the write path independent of any compressor, external binary or Node feature.

### 4. Startup invariants (violating them fails startup)

`validateRegistry()` mirrors the host's startup checks, and `reHome()` validates both **before** and
**after** mutating:

- no two workspace records may share a `path`
- one `sessionId` may not appear in more than one workspace ledger
- `global.workspaceIds` may not contain duplicates
- the set of `global.workspaceIds` must equal the set of `tables.workspaces` keys (order drift fails)

### 5. Lossy encoding collisions

`projectKey` folds `/`, `\`, `:` into `-` and truncates to 251 chars, so `C:\x\y` and `C:\x-y` encode
**identically** — and the host's `realpath` uniqueness check cannot catch that.
`detectProjectKeyCollision()` and the plan layer's check block it before anything is touched.

## Layout

`src/` is the source (TypeScript); `lib/` is build output (tsdown, not in git).

| File | Responsibility | DSH dep |
|---|---|---|
| `src/project-key.ts` | character-exact replica of the host's `projectKey()` + collision detection | none |
| `src/paths.ts` | `encodeSegment()`, generation filenames, session dir/log paths | none |
| `src/zstd-frame.ts` | raw frame encoder, first-frame boundary, multi-frame guard | none |
| `src/session-log.ts` | single-log read + **structure-preserving** cwd rewrite | none |
| `src/registry.ts` | registry startup-invariant validation, `reHome()`, atomic write | none |
| `src/discovery.ts` | bucket scan + header-only read (fast discovery) | none |
| `src/plan.ts` | read-only plan: target derivation, blockers, ledger change | none |
| `src/journal.ts` | byte-level backup manifest and rollback | none |
| `src/execute.ts` | apply + independent verification | none |
| `src/artifacts.ts` | artifact extraction (evidence layering), planning, moving | none |
| `src/transfer.ts` | `.dhsess` container (build/parse/validate), import planning and apply | none |
| `src/migrate.ts` | Migration orchestration: preview / apply / rollback / backup listing (shared by CLI, tools and the UI) | none |
| `src/cli.ts` | offline CLI (plan/apply/verify/rollback) → `lib/cli.js` | none |
| `src/tools.ts` | the 4 tool registrations | `dsh-tools` |
| `src/web.ts` | UI endpoints (list / export / import / migrate / backups / rollback); needs only a `{ register }` shape | none |
| `src/client/*` | Web Client half: the Session management page (tabs: import/export and migrate), dictionaries, styles, endpoint calls → `lib/client.js` | none |
| `src/index.ts` | plugin entry `apply(ctx, config)` | `dsh-tools` |

The core stays free of DSH dependencies, so the plugin shell, the CLI and the tests all reuse the same
code.

## Testing

```bash
pnpm install          # tests import src/*.ts directly (native type stripping); they need the peer dep
node test/run-all.mjs
# with real-data regression (point at any backup containing a sessions/ bucket):
DSM_FIXTURE=/path/to/backup node test/run-all.mjs
```

**Do not use `node --test`**: it spawns one child process per test file (piped stdio), which necessarily
fails with `spawn EPERM` under the DSH Windows sandbox — unrelated to the tests themselves.
`test/run-all.mjs` imports each test file in the same process instead.

See [docs/development.md](docs/development.md) for how the tool-layer tests resolve the real
`@deepseek-ai/dsh-tools`, and [docs/internals.md](docs/internals.md) for the full rationale.

`test/artifact.test.mjs` smoke-tests the **built artifact**: it loads `lib/index.js` and asserts the
entry fields, the 4 tool registrations, the UI endpoint registrations and the `apply()` disposer
contract — closing the gap between "the source passes" and "the artifact actually loads in a host".
`test/client.test.mjs` does the same for the Web Client half: it runs `lib/client.js` through a fake
`window.__ModuleLoader__` following the module-loader contract, and asserts the factory id, the export
surface, the slot it registers into and that both dictionaries share one key set. Both skip when the
build is absent; `pnpm run build && pnpm test` is the all-green command. The real-data case is gated
behind `DSM_SMOKE_WORKSPACE` and additionally asserts that a read-only `plan` created no target bucket.

`test/transfer.test.ts` covers the `.dhsess` byte round-trip, the rejection surface of bundle
validation (sha256 / truncation / magic / version), import preview and apply, id-collision skip, and
the no-cwd and plain-v0 branches. `test/web.test.ts` drives the endpoints with fake req/res objects:
listing, export, import (preview/apply) and every 400/404/409 rejection.

## License

MIT
