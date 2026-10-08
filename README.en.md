<img src="icon.svg" width="56" alt="">

# dsh-session-manager

A session manager for DSH: **move** workspaces and sessions to a new directory, **export / import**
sessions as `.dshsess` bundles, and **sync** them across machines over **WebDAV**.

[中文](README.md) | English

In DSH, "which workspace a session belongs to" is not an editable field — it is derived from the `cwd`
in the session log header. The host exposes no move / reassign API, and it rejects a log whose project directory
disagrees with its `cwd`. So moving directories by hand either drops sessions into Ungrouped or makes
them fail to load with `corrupt session log`. This plugin does all three things together — **rewrite the
header `cwd` + move the log directory + make the host accept the new grouping** — showing you that plan before it
writes anything, and rolling back byte-for-byte afterwards. (Why it has to work that way:
[.agents/notes/implemented/](.agents/notes/implemented), in Chinese.)

Sync takes the same road: the remote holds only `.dshsess` bundles, and a pull rewrites the `cwd` to
**this machine's** mapped directory, so the same project living in different directories on two machines
still works.

## What it gives you

| Entry point | Good for |
|---|---|
| The **Session management** page in Settings | Everyday use: archive or delete single sessions on the **Sessions** tab; pick source and target directories from the candidate panel to migrate (the source may also be Ungrouped); tick sessions to export / import; run a WebDAV sync on the **Sync** tab; roll back or restore on the **Backups** tab |
| 5 model tools | Just say "move this workspace's sessions to `~/dev/xxx`" and let the model preview first, apply second |

Both share one migration implementation, so the count the dialog reports is the count you get.

Every write action on the page (delete / migrate / import / sync / roll back) is **one button that opens one
confirmation dialog**: the dialog shows the read-only plan (which sessions, where they land, where the backup
goes, what is wrong), and only Confirm writes — Cancel changes nothing. The model tools still take two calls
(`plan` then `apply`), so the model looks before it writes.

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

Every action that can take a while **reports progress**: the dialog body of migration, deletion, rollback and
import (preview and apply), the action row of archiving, and the page header during the library scan all say
"Rewriting logs 8 / 253" with a bar and the title of the session in flight. The denominator is **how many
items that step will really do** (skipped ones are not counted, or the bar would never fill); steps without a
denominator (reading the remote index, writing the workspace registry) only say what they are doing and
draw no bar. While an apply runs, the dialog title switches from "About to
migrate" to "Migrating…" and the cancel button is disabled — letting go halfway leaves the library in a
half-done state. The one exception is **export**: its response body *is* the bundle, so there is no "item N of
M" to report.

**Sessions** — manage the whole library row by row

- The list is **grouped by directory** with foldable headers (**Collapse all / Expand all** sit above the
  list), and clicking a header toggles that whole group — so
  "archive every session of this old project" is one click. A header carries **only the name of its
  group**: the workspace title, or for a directory no workspace registers **the project name** (the last
  segment of its project identity — `dsh-session-manager` — when it has a git remote, and the local path
  when it does not), so rows no longer repeat the owner; **the project identity and the local path both
  live in that name's tooltip** (two lines: identity first, path below — the path is what tells two
  clones of one repository apart), a directory whose identity is known also carries a small **host tag**
  (`github.com`, `git.hehome.xyz`) after the name, so a glance shows which directories are repositories the
  identity knows about, and that tag's own tooltip gives the full identity, and a session sitting in the
  shell sidebar's Ungrouped group carries a small "Ungrouped" tag (the header is the directory, the tag says
  where the shell puts the row). **Subagent sessions are indented one level under their parent** (they
  follow it; when the parent lives in another directory group the row stays in its own group, indented, and
  says where the parent is), so which row belongs to which never has to be guessed from tags. Every row
  shows the title, the byte count and the creation time. Sessions the
  host sidebar cannot show **are listed here** (the sidebar cannot reach them), each carrying a tag saying
  why: `subagent` / `blank` / `archived`, plus `active` for a session still live in host memory;
- **Filter**: a row of small chips — subagent / blank / archived / ungrouped / active, each with the
  count in the library. Tick several to see several kinds (multiple = either), **All** clears them. The
  line below is a **title / id search box** (both are searched: "name it by id" and "the one where I asked
  about that" are both everyday needs). The header then reports "showing N / M", and **Select all picks
  what is listed right now** (filter to blank, select all, delete them), with **Clear** sitting next to it
  (it empties the whole tick set, so a partial tick can be cleared too), while ticking survives switching
  filters;
- **Archive / Unarchive**: tick rows and put them away or bring them back in one click. It goes through
  the host's own archiving capability and takes effect **immediately** — the sidebar follows right away,
  no restart. Ticking a parent session archives its subagents with it (the family is the unit; why, see
  the delete bullet below). On a host without that service (non-Web profiles) the buttons are disabled
  and the page says why;
- **Delete**: tick rows → **Delete selected** opens a dialog listing every session that would go, the
  file count and where the backup lands → confirm there. Deleting **backs the session directory up into this plugin's backup root
  first**, then removes it; the sidebar drops those rows once the host rescans. A session still live in
  host memory is refused — close it in the host first. Changed your mind? Restore it from the **Backups**
  tab;
- **Subagents follow their parent session**: ticking a parent takes its subagent sessions (and any
  deeper descendants) with it — the dialog lists them row by row, marked as going with the parent, and
  one backup holds the whole family (once the parent's log is gone a subagent has no way back into the
  sidebar, so leaving it on disk just makes it invisible). **A subagent cannot be deleted, archived or
  exported on its own**: its checkbox is greyed out (the tooltip names the parent session to tick), and
  calling the endpoint directly is refused with that same pointer — deleting it alone would leave the
  parent's log with a catalog entry pointing at a session that no longer exists. An orphan (its parent
  is no longer in the library) is the exception: there is nothing to follow, so it can be cleaned up on
  its own. **A forked session does not count**: it is a self-contained ordinary session (the source's
  history was copied into its own log), it still opens once the parent is gone, so it is not taken
  along.

**Migrate** — move one directory's sessions to another directory

- source and target are each **one value control whose text is the path in use**; clicking it opens the
  **candidate panel** (the import's landing directory on the **Transfer** tab is the very same control —
  see **Import** below), whose candidates are registered workspaces **plus any directory the library
  actually holds sessions for** (annotated with that count) **plus Ungrouped** (only the source has the
  last two), so no path has to be typed from memory. Each row carries two lines (the name on top, the local path and session count
  below, the whole string in its tooltip) and the **filter box** above them narrows the list by path,
  workspace title or project identity — it only filters the candidates and never touches the value.
  **Clicking a row selects it** (and collapses the panel); the other two routes sit in the panel head and
  in the field: **Browse the file system…** opens the OS directory dialog on the desktop and expands the
  in-page directory browser in the browser (on a host with no picker that button is simply not shown),
  and **Type a path** covers anything outside the candidates. A directory with a git remote reads as
  **project identity + local path**
  (`github.com/he0119/dsh-session-manager — /home/uy_sun/dev/dsh-session-manager`): that control has a
  single line, so the path cannot disappear from here — it is what tells two clones of one repository
  apart;
- **the source can also be Ungrouped**: the sessions with a `cwd` that the shell sidebar parks in its
  Ungrouped group, possibly spread over several directories — adopt them all into the target workspace in
  one go. It is the only source that spans directories, because "those two
  unclaimed sessions across two directories" really is one thing. The "carry ungrouped sessions" and
  "move session artifacts" switches do not apply there (the page says so instead of showing switches that
  do nothing);
- the target directory must already exist; there is also an optional title for a newly created workspace,
  whether to carry the **files the sessions created**, and whether to carry ungrouped sessions;
- **move the whole source, or only some of it**: the sessions of the source are listed
  (titles too, ids on hover; under a directory source the Ungrouped rows carry an "Ungrouped" tag), with a
  **title / id search box** above them to narrow the list, and ticking any row switches to "only the ticked
  ones"; one source per run. The row above that list carries the same pair as the **Sessions** and
  **Transfer** tabs: **Select all** picks only what is listed right now (and switches to "only the ticked
  ones" with it), while the **Clear** next to it empties the whole tick set. Switching back to **All**
  clears the ticks — "All" moves the whole source and does not go by ticks. This page gets no category
  chips: its candidates already exclude everything the sidebar cannot show, so those categories would
  always read 0 here — showing them would only look like a broken filter;
- **candidates line up with the host sidebar**: subagent sessions (nested under their parent), blank
  sessions (never started a turn) and archived sessions are never candidates — a session the sidebar
  cannot show should not be swept along by accident. Naming one of them explicitly makes the plan say
  it is hidden (for a subagent it also tells you to name its parent instead);
- **Subagents follow their parent session**: ticking a parent **moves its subagent sessions** (and any
  deeper descendants) with it (archiving and exporting work the same way: the subagents are archived, or
  packed into the bundle, together with the parent) — each log header's cwd is rewritten and each session directory moves into
  the target project directory, all in one backup (otherwise the family ends up split across two
  directories, and a subagent cannot be moved on its own: it is not a candidate, and naming it would be an
  upward link). **A forked session does not count** either (it is self-contained, and it still opens
  after the parent has moved). Membership does not change: a subagent was not registered, and still is
  not; the plan reports how many of the sessions are subagents;
- **Migrate opens the dialog**, which shows row by row the sessions that move (subagents that come along are
  indented one level and tagged "with parent"), the session / log / byte counts, source → target project
  directory, **how the registry changes** (create or reuse the target workspace, how many sessions are added,
  which workspaces lose them, whether an emptied workspace is removed), the artifact plan and its skip reasons;
- **Confirm** then rewrites each log header `cwd` (first frame only, the rest byte-identical) → move the session
  directories → write the registry → **hand the work to the host** (reuse or create the target workspace, attach
  the sessions, drop a source workspace once it is empty — see "Things to know" below) → **independent
  verification** (the host's own corrupt criterion, plus a "session ids unchanged" check) → leave a byte-level
  backup. Afterwards the page tells you whether the change took effect immediately or **requires a DSH
  restart**.

**Transfer** — take sessions away, bring them back

- Rows show a session's **title**, with the full title and the id on hover: a uuid tells a human nothing,
  and people pick sessions by "the one where I asked about that"; a session with no title falls back to
  its id. Both the export list and the **Sessions** tab take the whole library, sidebar-hidden sessions
  (subagent / blank / archived) included — whether a session is worth taking away or deleting is the
  user's call, and hiding one up front only turns "I know I have that session" into a mystery. Migration
  is the other way round (see below);
- **Export**: tick sessions → the browser downloads one `.dshsess` bundle. The bundle carries the raw
  bytes of **every generation** of those logs (each with a sha256), not files the session created. The
  list is **grouped by directory** (group name = workspace title; a directory no workspace registers is named
  after the last segment of its project identity — its git remote when it has one, its path otherwise — and is
  marked either way; the identity and the local path both live in that name's tooltip, and a directory whose
  identity is known carries a small host tag),
  and **clicking a group header toggles that whole group** — so "take every
  session of this workspace away" is one click. The chevron at the head of a row **folds** the
  group away (the header and its "N sessions / M selected" stay), and the "Grouped by directory" row above
  the list carries **Collapse all / Expand all**: folding is a display matter, so "Select all"
  still counts what is listed — clicking an arrow never quietly drops sessions from the export. The two levels never read alike: a group header is a tinted
  band with a folder glyph, while session rows are indented under it and carry a chat-bubble glyph (a session
  title is a sentence the user wrote, so it easily looks like a directory name). Subagent sessions sit one
  level deeper, under their parent session (the parent-child links here are the very tree that decides who
  a delete or a migration takes with it); sessions in the shell sidebar's Ungrouped group stay with their
  directory here and carry a small "Ungrouped" tag saying so.
- **Filter**: the same set as the **Sessions** tab — a row of small chips (subagent / blank / archived /
  ungrouped / active, each with the count in the library, multiple = either, **All** clears them) plus a
  **title / id search box**; used together the two are ANDed (search foo, show blank only = blank sessions
  among foo). The header then reports "showing N / M", and **Select all picks what is listed right now**,
  with the **Clear** next to it emptying the whole tick set; a group whose rows were all filtered out is
  not drawn at all (a header with nothing under it looks broken), and a group header reports the filtered
  count;
- **Import**: pick a bundle and a landing directory — that field is the **same control with the same
  candidates** as the migration target (the value control opens the candidate panel, and you can also type
  a path or browse the file system) → **Import** opens a dialog listing, per session, what will
  be created, which `cwd` gets rewritten, what is skipped and how the registry changes → confirm there (with
  nothing to create the confirm button is greyed out). Export never asks: it only packs bytes for download and
  touches nothing locally. Import **never overwrites**: a session whose id already exists is skipped and reported; a session with no `cwd` lands in
  the `_no-cwd` project directory and is not registered.

**Backups** — the undo surface shared by the operations that write: every backup this plugin wrote (time,
**migration** / **delete** / **before overwrite**, session count, source → target), with the steps shown
before you confirm. A migration backup offers **Roll back**: it restores the session directories, the log
bytes and the workspace registry together (and removes the emptied target project directory, symmetric with
the migration cleaning up an emptied source project directory). A backup from a delete or from a sync
overwriting this machine’s copy offers **Restore**: it only moves the backed-up copy back — those two never
touched the registry.

**Help** — the vocabulary and the costs in one place: the category dictionary (visible / subagent / blank /
archived / active / Ungrouped, where Ungrouped is exactly the shell sidebar's Ungrouped group: nothing claims
it and the sidebar shows it), what the five tabs do, which files the actions touch (backups, roll back vs
restore, when the sidebar follows), where the data comes from (the library and the registry paths), and the
common questions (which sessions count as Ungrouped, why a deleted session is still in the sidebar, when a
migration asks for a restart). The action tabs
(Sessions / Migrate / Transfer / Sync / Backups) keep only the decision at hand, so each explanation there stays
within two lines.

A host without the `webServer` service (tools-only front ends) still loads the plugin — the page simply
does not appear.

The bottom-right corner of the page says **which build this is**: a release shows just the version
(`v0.3.1`); a build made straight from the repository adds a short commit (`v0.3.1 · 0b8c452`), plus a
`-dirty` suffix when the working tree had uncommitted changes at build time. Hover for the full sentence
(release or local build).

### Sync (WebDAV)

The same project usually lives in different directories on different machines (`/home/alice/dev/proj` vs
`/opt/work/proj`), so syncing the session library itself cannot work: a library's directory names are bound
to the header `cwd`. Instead the remote is a relay — it holds `.dshsess` bundles, and landing one still goes
through the import path, which rewrites the `cwd` to this machine's mapped directory.

Config (the `sync` block of the plugin configuration):

```yaml
sync:
  url: https://dav.example.com/dsh        # WebDAV address (a server root works); the plugin creates dsh-session-manager/ under it
  machineId: robot-a                       # optional, defaults to the hostname; never share one id across machines
  username: alice                          # optional (Basic)
  passwordRef: DSH_DAV_PASSWORD            # optional: a **credential reference** (an environment-variable name); blank uses DSH_DAV_PASSWORD
  mapping:                                 # explicit mapping: remote cwd → local directory (each machine writes its own)
    /home/alice/dev/proj: /opt/work/proj
  timeoutMs: 30000                         # optional
```

This section is also editable **in the interface**: in the card on Settings → “Session management” → “Sync”, the URL, machine id, username, password, timeout and mapping are
edited directly (a field left empty uses the default shown in grey: the machine id falls back to the
hostname, the timeout to 30000 ms), and Save writes them into the profile document (`~/.dsh/profiles/<name>/cordis.patch.yml`).
`sync` is a volatile field, so a change takes effect **without a restart**; the three path fields
(`sessionsRoot` / `registryPath` / `backupRoot`) stay file-only. Path mappings are added and removed row
by row: the left side is the cwd the remote recorded, the right side a directory on this machine. That left
side must match the other machine’s path character for character, so once you have synced (and the plan in the
dialog has seen them), the form offers those cwds as suggestions instead of making you copy them by hand.

**The password goes in that same form**: it is a write-only input, and Save stores it in the host credential
store (`$DSH_HOME/.credentials.yaml`); the configuration file only ever carries the reference, the value is
never echoed back, and the form reports just “configured / not set”. The reference is not on that form: it is
the configuration’s own `sync.passwordRef` (`DSH_DAV_PASSWORD` by default), so pointing at a name of your own
(or at a variable you already export) is done on the generic plugin-config form. A variable present in the
launching environment shadows the write, and the password input is then shown as read-only.

**Once it is configured, press “Test connection”**: it probes the remote once, read-only (two PROPFINDs,
nothing is written), and answers with one sentence — reachable or not, authenticated or not, right address or
not; on an authentication failure it separates “no username”, “the reference has no value” and “the server
rejects this username/password”. It tests the **saved** configuration (the host runtime reads the config live),
so the button is disabled while there are unsaved edits. Write permission is not tested here: the first sync
creates that collection anyway, and a test should not leave anything on someone’s server.

**One configuration for every machine**: each entry in the remote index also carries a **project identity** —
the repository’s git remote (canonicalised to `host/owner/repo`) plus the session cwd relative to the
repository root. On a pull, the local side matches that identity against its own candidate directories (session
cwds and the paths registered as workspaces) and lands the session at `local repository root + relative path`.
All machines can therefore share a **literally identical** configuration (same `url`, no `machineId` so it
defaults to the hostname, empty `mapping`), and the same repository cloned at `/home/alice/dev/proj` and
`/opt/work/proj` still matches. Conversely, two different repositories that happen to share a directory name
are not treated as one project. No git, not a repository, no remote, or the project missing locally — all fall
back to the mapping table below, and the plan names the repository it could not resolve.

`mapping` and the identity **coexist**: an explicit mapping wins (what you configured is where it lands), the
identity is the automatic path. So non-git directories, or forcing a different destination, still use mappings.

The remote layout is `dsh-session-manager/<machineId>/index.json` (which sessions this machine contributed)
plus `dsh-session-manager/<machineId>/<id>.dshsess` (one bundle per session). The plugin creates that
namespace under `url` itself, so `url` may be a WebDAV server or account root. **One slot per machine**:
WebDAV has no locking, so each machine writes only its own slot and reads every slot — nothing overwrites
anything else.

On the **Sync** tab, **Sync** first computes a read-only plan in a dialog (it reads the remote and writes
nothing), reporting "pull N / push M" in three tables (will pull / will push / on both sides, left alone), each
**grouped by project directory**: the group header carries the name of its group (the workspace title, or the
project name when no workspace registers it), a small host tag when the identity is known, and the count, with
the project identity and the local path in that name's tooltip, while a
row keeps only the action, the session name and its size (the name carries the **same type tags as the session
list**: subagent / blank / archived / live, for the sessions this machine already has), and the third column of
the "left alone" table names
the machine holding the other copy. **Sync now** in that dialog actually pulls and pushes. While it runs, the
dialog body becomes a progress bar with "Pushing 12 / 84" and the title of the session in flight — the
denominator is the number of items that leg will really do (skipped ones are not counted), and pulling and
pushing each get their own pass.
The rules and edges:

- **When both sides hold the same id, contents and the last-activity time decide who is newer**:
  identical contents (apart from the cwd) stay put; a local copy that really is a prefix of the
  remote one is re-uploaded to refresh the remote; a remote copy that is ahead (yours is its
  prefix) or a both-wrote case where the remote is later **backs your copy up and then replaces
  it** (the old one can always be restored from the backup list on the Migrate tab); if either
  side has no last-activity time (an older remote index, or a host without the projection cache)
  or both are equally new, neither copy is touched and the report says whether it is "remote is
  ahead" or "both sides wrote". That last-activity time is the **later** of two clocks the host
  folds out of the log (the last prompt, and the last message — the agent's own writes count, so
  "you kept working after pushing" still has an answer), and neither copying nor cwd rewriting
  changes it. The judgement is a generation fingerprint **independent of the cwd**: landing always
  rewrites the other machine's cwd (library directory names are bound to the header `cwd`), and
  comparing raw bytes would call a pulled copy "both sides wrote" — pushing a continuation of it
  back would then never happen;
- **A strictly-ahead local copy is re-uploaded**: the versions both sides share match apart from the cwd, so
  the remote copy really is a prefix of yours and refreshing it loses nothing; when more than one machine
  contributed the same id, the pulling side takes the **ahead** copy rather than the one whose slot name
  sorts first;
- **Blank sessions take no part**: one that was created but never started is not pushed (the dialog reports
  "skipping N blank sessions"), and the next push drops it from this machine's own index too — so other
  machines stop seeing it; when the local copy is blank and the remote one has content, the remote wins
  (there is nothing in an empty copy worth protecting);
- A session you delete disappears from your own index on the next push (the remote bundle is not deleted),
  and copies other machines already took are unaffected;
- A session without a `cwd` gets no invented path (it lands under `_no-cwd`, same as import); a `cwd` with no
  mapping is skipped and listed;
- Pulled sessions need a host rescan to appear in the sidebar: once the registry changes, the plugin hands the
  work to the host (the same semantics as migration), and only asks for a restart when the host lacks those
  actions — the confirm dialog says so **before** you apply, and a single warning line stays on the page
  afterwards (when the host takes the change itself, neither appears).

Sync also goes through a plan: the `sync_sessions` tool previews by default and only writes with `apply:true`.

### Model tools

| Tool | Writes | Purpose |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session/file counts, target project directory, registry change, blockers |
| `migrate_sessions` | needs `apply:true` | Dry-run by default; performs a byte-level backup and self-verifies after |
| `rollback_session_migration` | yes | Byte-exact rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that a project directory agrees with its headers |
| `sync_sessions` | needs `apply:true` | Sync with the WebDAV remote (pull what other machines pushed, push what only this machine has; when both sides hold the same id, contents and the last-activity time pick the newer copy); dry-run by default |

## Things to know

- **The work is handed to the host, so a restart is normally unnecessary**: the `workspace.json` on disk is only
  the third copy — the host's in-memory registry is authoritative (writes change it; it never re-reads the file),
  and it also keeps a header index built at startup. So after changing the registry the plugin does not wait for
  the host to notice: it asks the host to take one fresh look at the disk (rebuild the header cache and the
  "where does this session live" index), then has the host reuse or create the target workspace, attach the
  sessions, detach them from the sources and delete an emptied workspace. The host persists those itself and
  notifies the UI, so the sidebar follows right away — without touching the process or killing a running turn.
  Session ids are only ever attached and detached, never minted or renamed; an existing workspace is reused with
  its own id. When the host lacks those actions (tools-only front end, older version), both the tools and the page
  say so and ask for a **DSH restart** — and until then, do not change any workspace: creating, renaming or
  archiving one would clobber this change with the in-memory copy.
- **Landing also folds the list metadata**: the title, the blank verdict and the last-activity time shown in the
  sidebar do not come from the log — they come from the host's own projection checkpoint, which the host only
  writes for **live** sessions. So after an import, a sync pull or a migration (which rewrites `cwd`), the
  plugin asks the host itself (read the log, then cold-fold the projections) to fill those in, and the sidebar
  shows names without opening each row once. It costs one extra full-log read per landed session; the ones that
  cannot be read are skipped per session and counted, and on a host without those services they keep waiting for
  a first open.
- **Look before it writes**: `plan` and the page's dialog (which shows that same `plan`) write nothing; every
  real write is preceded by a byte-level backup.
- **Only the first frame is rewritten**: only the header frame is recompressed, the remaining frames stay
  byte-identical, and rollback restores everything byte-for-byte (including the session artifacts, when you
  ask for them).
- **Paths**: neither session `cwd` values nor registry paths carry a trailing slash; `projectKey` folds `/`,
  `\` and `:` into `-`, so a few paths collide in that encoding — the plan layer blocks those up front.
- **Sync picks the newer copy**: when the remote one is newer (or both sides wrote and it is later), your
  copy is **backed up first and then replaced**; if either side has no last-activity time, neither is touched
  (see the edges in the Sync section).
- **Plugin config**: the optional `sessionsRoot` / `registryPath` / `backupRoot` fields override the default
  paths above; a `sync` block configures WebDAV sync (`url` / `machineId` / `username` / `passwordRef` /
  `mapping` / `timeoutMs`). A password is only ever a **reference** (an environment-variable name), never
  plaintext in the config file: a password typed in the interface goes to the host credential store
  (`$DSH_HOME/.credentials.yaml`), not to this configuration.

## Docs

- [.agents/notes/](.agents/notes/AGENTS.md) — the reasoning behind each decision and what was rejected
  (Chinese): the silent data loss of multi-frame zstd, the startup invariants, the lossy-encoding
  collision, the `.dshsess` container trade-offs, the effect mode, how sync decides which copy is newer and
  why blank sessions are not moved, and the UI decisions
- [docs/internals.md](docs/internals.md) — a decision map indexing the notes above by topic
- [docs/development.md](docs/development.md) — local workflow: deps, build, tests, a dev instance
- [docs/releasing.md](docs/releasing.md) — release process

## License

MIT
