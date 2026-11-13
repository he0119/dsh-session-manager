<p align="center">
  <img src="icon.svg" width="56" alt="">
</p>

<div align="center">

# dsh-session-manager

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

</div>

A session manager for DSH: one **Session management** page in the sidebar to move sessions to
another directory, export / import them as `.dshsess` bundles, archive and delete them, plus
**WebDAV sync** across machines. Every action that writes to disk shows you a plan first, writes
only after you confirm, and leaves a backup you can roll back.

[中文](README.md) | English

Why a plugin is needed: in DSH, "which workspace a session belongs to" comes from the working
directory (`cwd`) recorded in the session log. The host has no API to change that field, and it
rejects a session whose log directory disagrees with its `cwd`. Moving the folder by hand either
drops the session into Ungrouped, or makes it fail to load with `corrupt session log`. This plugin
does all of it together — rewrite the `cwd`, move the log directory, make the host accept the new
grouping — so the sidebar shows the right grouping the moment it finishes.

## Install

From npm (recommended):

```bash
npx @deepseek-ai/dsh@next plugin --profile desktop add @he0119/dsh-session-manager
# then restart DSH
```

From this checkout while developing (`lib/` is not committed, so build first):

```bash
pnpm install && pnpm run build
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-manager
# then restart DSH
```

After the restart the sidebar gains a **Session management** icon that opens as a full main-column
page.

`github:` installs are **not** supported: the build runs in `prepublishOnly` and `lib/` stays out of
git, so a git install gets no artifacts. The host must be 0.2.x (`engines.dsh` and the two DSH peers
are `^0.2.0-rc.1`); moving to the 0.3 line means bumping those lines together.

## Where things are

| Entry point | What it is for |
|---|---|
| **Session management** in the sidebar | Everyday use: the whole library in one table. Tick sessions to archive, retitle, migrate, export or delete; import and backups sit in the bottom status bar, sync is the state button in the page header |
| The **Sync** section on the plugin page | Configure WebDAV: remote URL, machine id, username and password, path mapping, auto sync (the page header's **Plugin settings** jumps straight there) |
| 6 model tools | Just say "move this project's sessions to `~/dev/xxx`" and let the model preview first, apply second |

The page has three parts: the project rail on the left (click a project to see only it, hover a
project row for a whole-group checkbox, with the filter chips at the bottom of the rail), the flat
library table in the middle (with a title / id search box above it), and the details of the selected
session on the right. Import and backups sit in the bottom status bar; sync is the state button in
the page header.

The **?** in the page header (Help) explains every session category (visible / subagent / blank /
archived / active / ungrouped) and the common questions; that one place covers it. The rest of this
README covers the tasks you will actually do.

## Move sessions to a new directory

1. On the **Session management** page, tick the sessions to move. They may come from different
   directories; a source folder you already deleted is no obstacle, since you tick rows in the list.
2. Click **Migrate** on the action row and pick the target directory. It must already exist; pick it
   from the candidates, type a path, or browse the file system.
3. Read the plan: which sessions move, which project directory they land in, how the workspace
   registry changes, where the backup goes.
4. Click **Confirm migration**. The plugin rewrites the `cwd` in each log, moves the session
   directories, updates the registry and hands it to the host, so the sidebar shows the new grouping
   right away. Usually no restart is needed.

Two limits worth knowing up front:

- **A session the host is using cannot move** (tagged `active` on its row). Restart DSH and migrate
  again to pick up the rest.
- **Sessions the sidebar cannot see do not move**: blank, archived and subagent sessions are left
  out, and the dialog tells you how many. Unarchive the archived ones first and delete the blank
  ones; subagent sessions travel with their parent and cannot be ticked on their own.

## Export and import

- **Export**: tick sessions and click **Export selected**; the browser downloads one `.dshsess`. The
  bundle holds the raw log bytes plus the images and file objects the logs refer to (without them
  the images are broken on another machine). Ticking a parent brings its subagent sessions along.
- **Import**: **Import…** in the bottom status bar, pick a bundle and a target directory, read the
  read-only plan, then confirm. You can also drop a `.dshsess` onto the page. Import **never
  overwrites**: a session with the same id already in the library is skipped and reported.

## Archive, retitle, delete

With sessions ticked, the action row does any of these in one click:

- **Archive / unarchive**: uses the host's own archiving, so the sidebar follows immediately, no
  restart.
- **Regenerate names**: recomputes titles from the whole conversation. Sessions you renamed by hand,
  subagent sessions, sessions with no user message yet and sessions with no model request at all are
  skipped; the result is reported as changed / unchanged / skipped / failed.
- **Delete**: backs up the whole session directory, then deletes it. Changed your mind? Click
  **Undo** in the success message, or restore it from **Backups & rollback** in the status bar. A
  session the host still holds in memory needs a DSH restart first.

## Sync across machines

The remote holds only `.dshsess` bundles, and a pull rewrites the `cwd` to this machine's path, so
the same project living in different directories on two machines still syncs. Fill this in under the
**Sync** section of the plugin page (or write it straight into the plugin config):

```yaml
sync:
  url: https://dav.example.com/dsh        # WebDAV URL (the server root works too); the plugin creates its own directory under it
  machineId: robot-a                      # optional, defaults to the hostname; never reuse one across machines
  username: alice                         # optional (Basic auth)
  passwordRef: DSH_DAV_PASSWORD           # optional: credential reference name (env var name)
  mapping:                                # optional: directory recorded remotely → directory on this machine
    /home/alice/dev/proj: /opt/work/proj
  timeoutMs: 30000                        # optional
  autoPush: true                          # optional: the "push only" mode of auto sync
# autoSync: true                          # the two-way mode; pick one of the two, this one wins if both are set
```

- **Type the password in the form**: it goes into DSH's credential store, the config file only keeps
  the reference name, and the page reports configured / not configured.
- **Click Test connection first**: it makes one read-only request to the remote (it writes nothing)
  and tells you whether it connected, authenticated, and whether the URL is right.
- **Manual sync**: click the sync state in the page header to get a read-only plan (how many to
  pull, how many to push, which ones both sides have), then confirm. When the remote copy is newer,
  this machine's copy is backed up first and then replaced; the old one can be restored from
  **Backups & rollback**.
- **See which item was left undone**: when the header chip turns amber, hovering it lists the first
  few items (which session, and why), and the "Last sync" block at the top of the dialog shows them
  all. Items tied to a session carry a "Show only this one" button that filters the list down to it.
  The record lives in `$DSH_HOME/dsh-session-manager/state.json`, so it survives a restart.
- **Auto sync** has three modes, one row in the form: off / push only / two-way. The background run
  waits until this machine has been idle for 5 minutes, so it never interrupts you while you write;
  "push only" pulls nothing — use manual sync or the two-way mode to pick up other machines'
  changes.
- **No need to copy paths**: a project with a git remote is matched by repository identity, so both
  machines can share one config. `mapping` covers non-git directories or forcing a landing spot, and
  wins when present.

## Configuration

| Key | Meaning |
|---|---|
| `sessionsRoot` / `registryPath` / `backupRoot` | Override the default session library, workspace registry and backup directory |
| `sync.*` | WebDAV sync, see the previous section |
| `tools.*` | Turn model tools off one by one: `plan` / `migrate` / `rollback` / `verify` / `sync` / `repair`; only an explicit `false` turns one off |

`sync` takes effect without a restart; `tools` needs a DSH restart, because tools are registered
when the plugin loads.

## Model tools

| Tool | Writes | What it does |
|---|---|---|
| `plan_session_migration` | no | Read-only plan: session and file counts, target directory, registry changes, blockers |
| `migrate_sessions` | needs `apply:true` | Dry run by default; backs up before writing and verifies afterwards |
| `rollback_session_migration` | yes | Byte-for-byte rollback from a backup directory |
| `verify_workspace_sessions` | no | Check that logs and headers inside one project directory agree |
| `repair_session_paths` | needs `apply:true` | Fix work-directory paths another machine left in a log (dry run by default) |
| `sync_sessions` | needs `apply:true` | Sync with the remote, dry run by default |

## Good to know

- Every write action leaves a byte-exact backup first, listed under **Backups & rollback** in the
  status bar. A migration backup offers **Roll back** (which also restores the workspace registry);
  delete and sync-overwrite backups offer **Restore**.
- Migration rewrites only the header frame of each log and keeps every other byte as is. Session ids
  never change, and the sidebar's title and blank checks are filled in right after the move.
- **A session imported from another machine (especially another OS)** also gets the paths in its
  `working-directory/change` events moved onto the local root at landing time. Without that the host
  cannot read it and the chat page reports a failed history load. Sessions already on disk are fixed
  with the `repair_session_paths` tool (dry run by default, byte-level backup before it writes).
- After a delete, the sidebar drops those rows once the host rescans the session library.
- On a host without a UI (tools-only front end) the page does not appear; the tools still work.
- The page's bottom right corner names the build: a release shows only the version, a local build
  adds a short commit.

## Docs

- [docs/flows.md](docs/flows.md) — what each action does from the UI down to the disk
- [docs/internals.md](docs/internals.md) — why it works that way, and an index of the decisions
- [docs/development.md](docs/development.md) — local development, build and tests
- [.agents/notes/](.agents/notes/AGENTS.md) — the reasoning and rejected alternatives per decision
  (in Chinese)

## License

MIT
