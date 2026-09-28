<img src="icon.svg" width="56" alt="">

# dsh-session-manager

A session manager for DSH: **move** workspaces and sessions to a new directory, and **export / import**
sessions as `.dshsess` bundles.

[中文](README.md) | English

In DSH, "which workspace a session belongs to" is not an editable field — it is derived from the `cwd`
in the session log header. The host exposes no move / reassign API, and it rejects a log whose bucket
disagrees with its `cwd`. So moving directories by hand either drops sessions into Ungrouped or makes
them fail to load with `corrupt session log`. This plugin does all three things together — **rewrite the
header `cwd` + move the log directory + re-home the workspace ledger** — and every step can be previewed
first and rolled back byte-for-byte afterwards. (Why it has to work that way:
[docs/internals.md](docs/internals.md).)

## What it gives you

| Entry point | Good for |
|---|---|
| The **Session management** page in Settings | Everyday use: tick sessions to export / import, pick a source (a directory or Ungrouped) from a dropdown to migrate, preview, confirm, roll back |
| 4 model tools | Just say "move this workspace's sessions to `~/dev/xxx`" and let the model preview first, apply second |

Both share one migration implementation, so the count a preview reports is the count you get.

## Install

From npm (recommended):

```bash
# DSH's own plugin command: it creates/populates the profile and maintains deps + lockfile
npx @deepseek-ai/dsh@next plugin --profile desktop add @he0119/dsh-session-manager
# then restart DSH
```

From this checkout while developing (`lib/` is not committed, so build first):

```bash
pnpm install && pnpm run build
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-manager
# then restart DSH
```

After the restart, **Settings** gains a **Session management** page in the left navigation (ordered after
the built-in pages). `github:` installs are **not** supported here: the build runs in `prepublishOnly` and
`lib/` is kept out of git, so a git install gets no artifacts.

## Usage

### Settings → Session management

**Import & export** — take sessions away, bring them back

- Rows show a session's **title**, with the full title and the id on hover: a uuid tells a human nothing,
  and people pick sessions by "the one where I asked about that"; a session with no title falls back to
  its id;
- **Export**: tick sessions → the browser downloads one `.dshsess` bundle. The bundle carries the raw
  bytes of **every generation** of those logs (each with a sha256), not files the session created. The
  list is **grouped by directory** (group name = workspace title; a directory no workspace registers shows
  its path and is marked), and **clicking a group header toggles that whole group** — so "take every
  session of this workspace away" is one click. The two levels never read alike: a group header is a tinted
  band with a folder glyph, while session rows are indented under it and carry a chat-bubble glyph (a session
  title is a sentence the user wrote, so it easily looks like a directory name). Sessions no workspace record
  claims — the ones the shell sidebar parks under Ungrouped — stay with their directory here and carry a small
  "not registered" tag saying so.
- **Import**: pick a bundle and a target workspace → **preview first** (per session: what will be created,
  which `cwd` gets rewritten, what is skipped, how the registry changes) → then confirm. Import **never
  overwrites**: a session whose id already exists is skipped and reported; a session with no `cwd` lands in
  the `_no-cwd` bucket and is not ledgered.

**Migrate** — move one directory's sessions to another directory

- source and target are each a **single dropdown that holds the value**; candidates are registered
  workspaces **plus any directory the library actually holds sessions for** (annotated with that count)
  **plus Ungrouped**, so no path has to be typed from memory. A path outside the candidates goes in through
  **Browse…** or **Type a path**: on the desktop **Browse…** opens the OS directory dialog, in the browser it
  expands an in-page directory browser, and on a host with no picker the button is simply not shown;
- **the source can also be Ungrouped**: the sessions no workspace claims that still have a `cwd` (the ones
  the shell sidebar parks under Ungrouped), possibly spread over several directories — adopt them all into
  the target workspace in one go. It is the only source that spans directories, because "those two
  unclaimed sessions across two directories" really is one thing. The "carry unregistered sessions" and
  "move session artifacts" switches do not apply there (the page says so instead of showing switches that
  do nothing);
- the target directory must already exist; there is also an optional title for a newly created workspace,
  whether to carry the **files the sessions created**, and whether to carry unregistered sessions;
- **move the whole source, or only some of it**: the sessions of the source are listed
  (titles too, ids on hover; under a directory source the unclaimed rows carry a "not registered" tag), and
  ticking any row switches to "only the ticked ones"; one source per run;
- **Preview**: session, log and byte counts, source → target bucket, **how the ledger changes** (create or
  reuse the target workspace, how many sessions are added, which workspaces lose them, whether an emptied
  workspace is removed), the artifact plan and its skip reasons;
- **Confirm**: rewrite each log header `cwd` (first frame only, the rest byte-identical) → move the session
  directories → re-home the ledger → **independent verification** (the host's own corrupt criterion) → leave
  a byte-level backup. Afterwards the page tells you whether the change took effect immediately or
  **requires a DSH restart**.

**Backups & rollback** — below the migrate tab, every backup this plugin wrote (time, session count,
source → target), with the **rollback steps** shown before you confirm. Rollback restores the session
directories, the log bytes and the workspace ledger together (and removes the emptied target bucket,
symmetric with the migration cleaning up an emptied source bucket).

A host without the `webServer` service (tools-only front ends) still loads the plugin — the page simply
does not appear.

### Model tools

| Tool | Writes | Purpose |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session/file counts, target bucket, ledger change, blockers |
| `migrate_sessions` | needs `apply:true` | Dry-run by default; performs a byte-level backup and self-verifies after |
| `rollback_session_migration` | yes | Byte-exact rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that a directory's bucket agrees with its headers |

## Things to know

- **An offline write only counts after a DSH restart**: the host holds an in-memory registry. If upstream
  exposes `workspaceRegistry.reassignSessions()`, the plugin takes effect immediately and says so; otherwise
  both the tools and the page tell you to restart — and until you do, do not add sessions under the old
  workspace.
- **Look before it writes**: `plan` and the page's **preview** write nothing; every real write is preceded by
  a byte-level backup.
- **Only the first frame is rewritten**: only the header frame is recompressed, the remaining frames stay
  byte-identical, and rollback restores everything byte-for-byte (including the session artifacts, when you
  ask for them).
- **Paths**: neither session `cwd` values nor ledger paths carry a trailing slash; `projectKey` folds `/`,
  `\` and `:` into `-`, so a few paths collide in that encoding — the plan layer blocks those up front.
- **Plugin config**: the optional `sessionsRoot` / `registryPath` / `backupRoot` fields override the default
  paths above.

## Docs

- [docs/internals.md](docs/internals.md) — why it is the way it is: the silent data loss of multi-frame
  zstd, the startup invariants, the lossy-encoding collision, the `.dshsess` container trade-offs, the
  effect mode, and the UI decisions
- [docs/development.md](docs/development.md) — local workflow: deps, build, tests, a dev instance
- [docs/releasing.md](docs/releasing.md) — release process

## License

MIT
