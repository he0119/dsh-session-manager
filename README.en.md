# dsh-session-mover

Migrate DSH workspaces and sessions to a new directory: rewrite session-log `cwd`, move the log
directories, re-home workspace membership, and optionally move the files those sessions created.

[中文](README.md) | English

> **Status**
> - ✅ Core library, migration engine, offline CLI, plugin shell and 4 tools
> - ✅ Tool contract verified against the **real `@deepseek-ai/dsh-tools`** (`defineTool` normalization
>   + argument validation + real execution)
> - ✅ Session-artifact migration: evidence layering + on-disk intersection + nested pruning, rolled
>   back together with the sessions
> - ✅ **59 tests pass** (real log files, real registry, end-to-end, byte-level rollback assertions)
> - ⏳ Pending your go-ahead: install into a profile and load it in a real DSH

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

Once installed you can also use the bin shim (`dsh-session-mover plan …`).

Defaults are `$DSH_HOME/sessions` and `$DSH_HOME/storages/workspace.json`; override with `--root` /
`--registry` / `--backup`. `plan` exits 2 when there are problems and never writes.

### Plugin tools (callable by the model)

| Tool | Writes | Purpose |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session/file counts, target bucket, ledger change, blockers |
| `migrate_sessions` | needs `apply:true` | Dry-run by default; performs a byte-level backup and self-verifies after |
| `rollback_session_migration` | yes | Byte-exact rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that a directory's bucket agrees with its headers |

### When it takes effect (dual mode)

`workspaceRegistry` holds an **in-memory** registry plus a header index, and the method that rebuilds
that index (`replaceHeaderIndex`) is private. Therefore:

- if the upstream host exposes `workspaceRegistry.reassignSessions()` → `effectMode()` detects it and
  the migration takes effect immediately;
- otherwise the on-disk write is correct but **DSH must be restarted** for it to be acknowledged.

The `takesEffect` field in every tool result reports which mode you are in, instead of pretending it
is immediate.

## Installing into a profile

```bash
# Canonical: DSH's own plugin command (creates/populates the profile for you)
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-mover
# then restart DSH

# Fallback / offline: idempotent installer, dry-run by default
node scripts/install.mjs           # preview only, writes nothing
node scripts/install.mjs --apply   # copy the package + add it to dsh.profile.bundles
```

Mechanism: `profiles/<name>/cordis.yml` is an empty `[]`; the tree is composed from
`package.json`'s `dsh.profile.bundles` (each bundle contributes its own `cordis.patch.yml`), then the
profile's own `cordis.patch.yml` (id-targeted overrides), then `--patch` overlays. So installing means:
put the package in `node_modules` and add its name to `dsh.profile.bundles`.

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
| `src/cli.ts` | offline CLI (plan/apply/verify/rollback) → `lib/cli.js` | none |
| `scripts/install.mjs` | idempotent installer (dry-run by default) | none |
| `src/tools.ts` | the 4 tool registrations | `dsh-tools` |
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

## License

MIT
