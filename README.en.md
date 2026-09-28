<img src="icon.svg" width="56" alt="">

# dsh-session-manager

A session manager for DSH: **move** workspaces and sessions to a new directory, and **export / import**
sessions as `.dshsess` bundles.

[中文](README.md) | English

In DSH, "which workspace a session belongs to" is not an editable field — it is derived from the `cwd`
in the session log header. The host exposes no move / reassign API, and it rejects a log whose project directory
disagrees with its `cwd`. So moving directories by hand either drops sessions into Ungrouped or makes
them fail to load with `corrupt session log`. This plugin does all three things together — **rewrite the
header `cwd` + move the log directory + re-home the workspace registry** — and every step can be previewed
first and rolled back byte-for-byte afterwards. (Why it has to work that way:
[docs/internals.md](docs/internals.md).)

## What it gives you

| Entry point | Good for |
|---|---|
| The **Session management** page in Settings | Everyday use: archive or delete single sessions on the **Sessions** tab; pick a source (a directory or Ungrouped) from a dropdown to migrate; tick sessions to export / import |
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
The host must be 0.2.0-rc.1 or a later 0.2.x (`engines.dsh` and the two DSH peers are `^0.2.0-rc.1`;
`@deepseek-ai/cordis` is `^4.0.4`). The host **decides whether to load the plugin from those peer ranges**:
if the running version falls outside them the whole bundle is skipped (the log line is
`skipping profile bundle … is incompatible with dsh …`). Ranges are evaluated with `includePrerelease`, so
a new rc on the same minor line (`0.2.1-rc.1`) is still accepted; a new minor line (`0.3.0-rc.1`) needs a
one-line bump at that point.

## Usage

### Settings → Session management

**Sessions** — manage the whole library row by row

- The list is **grouped by directory** with foldable headers (**Collapse all / Expand all** sit above the
  list), and clicking a header toggles that whole group — so
  "archive every session of this old project" is one click. A header carries the workspace title and path,
  so rows no longer repeat the owner; that width goes to the title instead, and a session no workspace
  record claims carries a small "Ungrouped" tag (the header is the directory, the tag says the registry
  does not know this row). Every row shows the title, the byte count and the creation time. Sessions the
  host sidebar cannot show **are listed here** (the sidebar cannot reach them), each carrying a tag saying
  why: `subagent` / `blank` / `archived`, plus `active` for a session still live in host memory;
- **Filter**: a row of small chips — subagent / blank / archived / ungrouped / active, each with the
  count in the library. Tick several to see several kinds (multiple = either), **All** clears them. The
  line below is a **title / id search box** (both are searched: "name it by id" and "the one where I asked
  about that" are both everyday needs). The header then reports "showing N / M", and **Select all picks
  what is listed right now** (filter to blank, select all, delete them), while ticking survives switching
  filters;
- **Archive / Unarchive**: tick rows and put them away or bring them back in one click. It goes through
  the host's own archiving capability and takes effect **immediately** — the sidebar follows right away,
  no restart. On a host without that service (non-Web profiles) the buttons are disabled and the page
  says why;
- **Delete**: tick rows → **preview** (every session that would go, the file count, where the backup
  lands) → then confirm. Deleting **backs the session directory up into this plugin's backup root
  first**, then removes it; the sidebar drops those rows once the host rescans. A session still live in
  host memory is refused — close it in the host first. Changed your mind? Restore it from
  **Backups & rollback**;
- **Subagents follow their parent session**: ticking a parent takes its subagent sessions (and any
  deeper descendants) with it — the preview lists them row by row, marked as going with the parent, and
  one backup holds the whole family (once the parent's log is gone a subagent has no way back into the
  sidebar, so leaving it on disk just makes it invisible). Deleting a subagent alone is allowed; the
  preview says that its line under the parent will never open again.

**Migrate** — move one directory's sessions to another directory

- source and target are each a **single dropdown that holds the value**; candidates are registered
  workspaces **plus any directory the library actually holds sessions for** (annotated with that count)
  **plus Ungrouped**, so no path has to be typed from memory. A path outside the candidates goes in through
  **Browse…** or **Type a path**: on the desktop **Browse…** opens the OS directory dialog, in the browser it
  expands an in-page directory browser, and on a host with no picker the button is simply not shown;
- **the source can also be Ungrouped**: the sessions no workspace claims that still have a `cwd` (the ones
  the shell sidebar parks under Ungrouped), possibly spread over several directories — adopt them all into
  the target workspace in one go. It is the only source that spans directories, because "those two
  unclaimed sessions across two directories" really is one thing. The "carry ungrouped sessions" and
  "move session artifacts" switches do not apply there (the page says so instead of showing switches that
  do nothing);
- the target directory must already exist; there is also an optional title for a newly created workspace,
  whether to carry the **files the sessions created**, and whether to carry ungrouped sessions;
- **move the whole source, or only some of it**: the sessions of the source are listed
  (titles too, ids on hover; under a directory source the unclaimed rows carry an "Ungrouped" tag), with a
  **title / id search box** above them to narrow the list, and ticking any row switches to "only the ticked
  ones"; one source per run. This page gets no category chips: its candidates already exclude everything
  the sidebar cannot show, so those categories would always read 0 here — showing them would only look
  like a broken filter;
- **candidates line up with the host sidebar**: subagent sessions (nested under their parent), blank
  sessions (never started a turn) and archived sessions are never candidates — a session the sidebar
  cannot show should not be swept along by accident. Naming one of them explicitly makes the preview say
  it is hidden (for a subagent it also tells you to name its parent instead);
- **Subagents follow their parent session**: ticking a parent **moves its subagent sessions** (and any
  deeper descendants) with it — each log header's cwd is rewritten and each session directory moves into
  the target project directory, all in one backup (otherwise the family ends up split across two
  directories, and a subagent cannot be moved on its own: it is not a candidate, and naming it would be an
  upward link). Membership does not change: a subagent was not registered, and still is not; the preview
  reports how many of the sessions are subagents;
- **Preview**: session, log and byte counts, source → target project directory, **how the registry changes** (create or
  reuse the target workspace, how many sessions are added, which workspaces lose them, whether an emptied
  workspace is removed), the artifact plan and its skip reasons;
- **Confirm**: rewrite each log header `cwd` (first frame only, the rest byte-identical) → move the session
  directories → re-home the registry → **independent verification** (the host's own corrupt criterion) → leave
  a byte-level backup. Afterwards the page tells you whether the change took effect immediately or
  **requires a DSH restart**.

**Backups & rollback** — below the migrate tab, every backup this plugin wrote (time, **migration** or
**delete**, session count, source → target), with the steps shown before you confirm. A migration backup
offers **Roll back**: it restores the session directories, the log bytes and the workspace registry
together (and removes the emptied target project directory, symmetric with the migration cleaning up an
emptied source project directory). A delete backup offers **Restore**: it only moves the session
directories back — deleting never touched the registry.

**Transfer** — take sessions away, bring them back

- Rows show a session's **title**, with the full title and the id on hover: a uuid tells a human nothing,
  and people pick sessions by "the one where I asked about that"; a session with no title falls back to
  its id. Both the export list and the **Sessions** tab take the whole library, sidebar-hidden sessions
  (subagent / blank / archived) included — whether a session is worth taking away or deleting is the
  user's call, and hiding one up front only turns "I know I have that session" into a mystery. Migration
  is the other way round (see below);
- **Export**: tick sessions → the browser downloads one `.dshsess` bundle. The bundle carries the raw
  bytes of **every generation** of those logs (each with a sha256), not files the session created. The
  list is **grouped by directory** (group name = workspace title; a directory no workspace registers shows
  its path and is marked), and **clicking a group header toggles that whole group** — so "take every
  session of this workspace away" is one click. The chevron at the head of a row **folds** the
  group away (the header and its "N sessions / M selected" stay), and the "Grouped by directory" row above
  the list carries **Collapse all / Expand all**: folding is a display matter, so "Select whole library"
  still counts what is listed — clicking an arrow never quietly drops sessions from the export. The two levels never read alike: a group header is a tinted
  band with a folder glyph, while session rows are indented under it and carry a chat-bubble glyph (a session
  title is a sentence the user wrote, so it easily looks like a directory name). Sessions no workspace record
  claims — the ones the shell sidebar parks under Ungrouped — stay with their directory here and carry a small
  "Ungrouped" tag saying so.
- **Filter**: the same set as the **Sessions** tab — a row of small chips (subagent / blank / archived /
  ungrouped / active, each with the count in the library, multiple = either, **All** clears them) plus a
  **title / id search box**; used together the two are ANDed (search foo, show blank only = blank sessions
  among foo). The header then reports "showing N / M", and **Select whole library picks what is listed
  right now**; a group whose rows were all filtered out is not drawn at all (a header with nothing under
  it looks broken), and a group header reports the filtered count;
- **Import**: pick a bundle and a target workspace → **preview first** (per session: what will be created,
  which `cwd` gets rewritten, what is skipped, how the registry changes) → then confirm. Import **never
  overwrites**: a session whose id already exists is skipped and reported; a session with no `cwd` lands in
  the `_no-cwd` project directory and is not registered.

**Help** — the vocabulary and the costs in one place: the category dictionary (visible / subagent / blank /
archived / active / Ungrouped, where Ungrouped means two different things), what the three tabs do, which
files the actions touch (backups, roll back vs restore, when the sidebar follows), where the data comes from
(the library and the registry paths), and the common questions (why Ungrouped counts more here than in the
sidebar, why a deleted session is still in the sidebar, why a migration asks for a restart). The action tabs
(Sessions / Migrate / Transfer) keep only the decision at hand, so each explanation there stays within two
lines.

A host without the `webServer` service (tools-only front ends) still loads the plugin — the page simply
does not appear.

### Model tools

| Tool | Writes | Purpose |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session/file counts, target project directory, registry change, blockers |
| `migrate_sessions` | needs `apply:true` | Dry-run by default; performs a byte-level backup and self-verifies after |
| `rollback_session_migration` | yes | Byte-exact rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that a project directory agrees with its headers |

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
- **Paths**: neither session `cwd` values nor registry paths carry a trailing slash; `projectKey` folds `/`,
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
