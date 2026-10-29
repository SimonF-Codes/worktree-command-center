---
status: stable
---

# Architecture

How the app holds a floor of sessions together: the processes involved, the coordination
directory they share, the two channels into the app, and where each session's instructions come
from. The external API built on top of this is in [api.md](api.md).

## Processes

- **The renderer** (`src/`) is the app proper. Each workspace is a `TerminalsGrid`, and each tile in
  it is a `TerminalTile` (a worktree or folder session) or a journal. Kane is a `GodConsole` docked
  beside the grid.
- **The PTY sidecar** (`pty-sidecar/sidecar.cjs`). Each `claude` session runs under its own small
  Node process that hosts it in a pseudo-terminal through `node-pty`. The renderer talks to it over
  stdio in newline-delimited JSON (`data` and `resize` in, `data` and `exit` out). It runs under the
  **system** `node`, not Electron's, so `node-pty`'s prebuilt binary matches. That is why `node`
  must be on PATH even for the installed app.
- **Sidecar scripts** ship in the same folder and are put on every session's PATH:
  - `cos-coord`: locks, board notes, chat, and Kane's overseer commands
  - `coord-hook.cjs`: the Claude Code hook that takes `git push` / `worktree add` locks automatically
    and records background tasks
  - `notify-ready.cjs`: the Stop/Notification hook that marks a session ready for input
  - `wcc-client`: the connector client for processes *outside* the app ([api.md](api.md#the-client--wcc-client))
  - `wcc-worktrees`: prune and relayout from the command line ([below](#the-worktrees-cli-wcc-worktrees))

The whole folder is copied into the installed app as `resources/pty-sidecar` (see
`package.json` → `build.extraResources`).

## The worktrees CLI: `wcc-worktrees`

The two worktree jobs in **⚙ Settings → Targets**, from a shell, one repo at a time:

```
wcc-worktrees prune    [<repo>] [--apply]   # remove worktrees whose work is merged
wcc-worktrees relayout [<repo>] [--apply]   # nest a repo's worktrees inside it
```

Both are **dry runs unless `--apply` is given**. `<repo>` is a target's name or path from
`config.json`. Leave it out to act on every repo target. A relayout with `--apply` stops at the
first repo that fails. Other flags:

- `--no-probe` skips the held-open probe, which renames each candidate in place and back.
- `--user-data <dir>` (or `WCC_USER_DATA`) points at a different app data folder. The default
  is `%APPDATA%/worktree-command-center`.
- `--projects-dir <dir>` points at a different Claude transcript folder. The default is
  `~/.claude/projects`.

Exit codes: `0` done (or nothing to do), `1` failed, `2` refused, `64` usage. A refusal always
puts its reason on stderr.

**It decides nothing itself.** It runs the app's own modules: `planPrune`, `describePrunePlan`
and `executePrune` from `src/prune-worktrees*.ts`, and `planMove`, `describeMovePlan` and
`executeMove` from `src/move-repo*.ts`. Those are TypeScript and import each other, so a plain
`.cjs` beside `cos-coord` can't load them. `esbuild.config.mjs` bundles `src/cli/wcc-worktrees.ts`
into `pty-sidecar/wcc-worktrees.cjs`. That file is generated and git-ignored: run `npm run build`
(or `node esbuild.config.mjs`) in a source checkout before using it. The installed app ships the
bundle.

**A relayout updates five things.**

1. The worktree directory, moved with `git worktree move`. The destination's parent is created
   first, because git won't create it.
2. Both ends of the worktree link. `git worktree move` rewrites them.
3. `<repo>/.git/info/exclude` gets `/.claude-worktrees/`.
4. `~/.claude/projects/<mangled>`, the transcript folder, is renamed. The mangled name is
   `projectDirName`, which replaces every non-alphanumeric character with `-`.
5. `.terminal-sessions.json` has each saved terminal's `worktreePath` rewritten. Any
   `config.json` tab links the path map touches are rewritten too. Both files are backed up
   (`.bak-<time>`) before the write and read back after it.

The dry run prints every one of these by full path. It also prints the move-repo refusals and
warnings unchanged:

- refused when both the old and the new transcript folder exist;
- warned when the destination is already keyed to an earlier worktree;
- warned, and not renamed, for transcript folders whose mangled name can't be reversed with
  certainty.

**`--apply` refuses while the app is running.** `persist()` rewrites `config.json` and
`.terminal-sessions.json` from memory. A session record rewritten from outside would be silently
put back, leaving a saved terminal pointing at a directory that has moved. The guard
(`src/cli/app-guard.ts`) is copied from `C:/dev/scripts/repoint-verticalchess.mjs`. It matches
the *stem* of the image name, because `tasklist` cuts names at 25 characters and prints
`Worktree Command Center.e`. A process list that can't be read counts as running.

The guard runs twice:

- before anything happens;
- again just before the sessions file is written. If the app was started mid-run, the relayout
  stops there, and a re-run picks up where it stopped.

It does not see a dev build started with `npm start`, which runs as `electron.exe`.

A prune dry run works with the app open, but every worktree is then kept as `live-unknown`. Only
the app knows which terminals are open.

**Why a directory won't move.** There are four causes, and neither git's error text nor Node's
errno tells them apart. On one held directory, Node's rename said `EBUSY` and
`git worktree move` said `Permission denied`. So `src/cli/hold-diagnosis.ts` checks the evidence
in this order:

| Mode | Evidence |
|---|---|
| `cwd-holder` | `find-cwd-holder.ps1` (shipped beside the CLI) names a process whose working directory is inside the directory. Checked first, whatever the errno. |
| `sync-engine` | The directory is under a OneDrive root (`%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`), or git said "Device or resource busy". |
| `service-handle` | Held, but no process has its cwd there. Antivirus or Windows Search holds the directory, while its contents stay writable. Nothing built in names the holder. A reboot clears it. |
| `parent-missing` | "No such file or directory": the destination's parent is missing. |

If the detector can't run, the CLI names both Permission-denied causes rather than guessing.
`who-holds.ps1` is not used. It can't see directory handles.

## The coordination directory

Each workspace has one:

```
<userData>/.coordination/<workspaceId>/
```

Every session in that workspace gets its path as `COS_COORD_DIR`, plus its own `COS_TERMINAL_ID`
and `COS_TERMINAL_NAME`. Everything sessions and the app say to each other goes through files
here:

| path | written by | what it is |
| --- | --- | --- |
| `locks/<resource>.json` | `cos-coord acquire`/`release`, the git hook | one file per held lock (`<area>:<thing>`) |
| `board.md` | `cos-coord`, the git hook | append-only feed of lock, note and task events |
| `chat.md` | `cos-coord chat` | the agent group chat |
| `worktrees.md` | the app, every worktree scan (30 s) | every worktree's branch, owner, dirty/ahead/parked state |
| `floor/INDEX.md` | the app, floor feed (4 s) | roster of live sessions, for Kane |
| `floor/<id>-<name>.md` | the app, floor feed | each session's recent output |
| `floor/state.json` | the app, floor feed | the same roster plus the worktree ledger, as JSON ([api.md](api.md#floor-state--floorstatejson)) |
| `god-outbox/` | `cos-coord` as Kane | Kane's commands to the app (below) |
| `god-outbox/.receipts/` | the app | outcomes `cos-coord tell`/`close` block on |
| `god-inbox/` | the app | failures of Kane's commands that happened after `cos-coord` returned |
| `connectors/<id>/requests/`, `receipts/` | outside callers, the app | the connector channel ([api.md](api.md#requests-and-receipts)) |
| `journals/` | the app | journal tile entries |

The parent `<userData>/.coordination/` also holds `floor-report.json` / `.md`, a cross-workspace
report (`src/terminals/floor-report.ts`), and `.god/`, Kane's own home directories.

**The floor feed** (snapshots, `INDEX.md`, `state.json`) is one timer and one pass, so the markdown
and the JSON always describe the same moment. It runs while the workspace has an overseer console
open. **The worktree scan** is a separate 30 s timer that runs `git` per repo and worktree. The
feed reuses the scan's last result rather than scanning again.

## Two ways in: `god-outbox/` and `connectors/`

The app takes instructions from two directories, and they carry different authority on purpose.

### `god-outbox/`: Kane's own channel (internal)

This is where Kane's `cos-coord tell/watch/spawn/rename/close/personality` writes. It carries the
overseer's privileged intent: typing into *any* terminal, renaming *anything*, toggling
`personality`. The overseer console *is* the app's own trusted UI. The `cos-coord` command refuses
those verbs unless `COS_ROLE=god`, which only Kane's sessions have.

It is **not** an integration point for anything else. Nothing technically stops a local process
from writing the same shapes into `god-outbox/`, because the role gate guards the *command*, not
the file format. But doing that means impersonating the overseer's full authority over the floor,
not requesting work. It's unsupported, not a shortcut. An outside process uses the connector channel.

`cos-coord tell` **blocks and reports honestly**. It doesn't return until the app confirms the
message actually landed on the target's screen (retried for up to `COS_COORD_TELL_WAIT_MS`,
default 45 s), and exits 0 only if it did. It exits non-zero with the reason on stderr when the
name didn't resolve, the session couldn't take input for the whole window (e.g. mid-`/compact`),
it closed while the message was queued, or the app never answered. Dropping the outbox file was
never proof of delivery. A `watch`/`rename`/`spawn` that fails after `cos-coord` returned (an
unresolved name, an unknown repo) writes a note to `god-inbox/` and pings Kane directly.

`cos-coord close "<name>"` blocks and reports the same way. It ends one worker session through the
memory panel's End path, not the tile's ×. Uncommitted work is parked as a `wip:` commit and the
process is killed. The worktree and branch stay, because the transcript in `~/.claude/projects` is
keyed by worktree path, and Reopen in the Coordination panel brings the session back with it.
It refuses, exiting 2 with the reason, when:

- no terminal has that name
- the name matches more than one terminal
- the target is a journal
- the target is an overseer console, which includes a Kane closing itself

A session that was mid-turn is still closed, and the result says `(was mid-turn)`. With no answer
within `COS_COORD_CLOSE_WAIT_MS` (default 45 s) it exits 2 and reports the close as *not
confirmed*. It never reports that as success.

`cos-coord new-tab "<tab>" [--repo <target> | --new-repo …]` asks the app for a workspace tab bound
to a repo: an existing target, or one it creates (folder, `git init`, seeds, initial commit,
optional GitHub remote). It blocks on the same receipt seam and is the one `cos-coord` command
that never fails open. Because a tab appearing hours later would be worse than none,
`drainOutbox` now **claims a drop by renaming it into `.done/` before acting** (the connector
drain always did this). A `new-tab` that nobody picked up within its wait is withdrawn by deleting
it, and exactly one of the two wins. The connector channel carries the same verb, behind a
per-connector grant. Both channels end in the same app code as the window's **+** and 🆕 buttons.
The contract, with every reason and exit code, is in
[api.md](api.md#new-tab-a-workspace-tab-bound-to-a-repo).

### `connectors/`: requests from outside

A separate, narrower path for a local process that is *not* the overseer to **request** work:
`spawn` and `tell` only. It uses its own directory pair per connector, a registration list in
`config.json`, and a receipt for every attempt. The full contract is in [api.md](api.md).

Both channels are armed when a workspace's grid is constructed, and every workspace's grid is
constructed at launch. Neither waits for Kane to be opened or for the workspace to be visited.

## Agent role files

The system prompt each session starts with can come from markdown files on disk instead of the
strings compiled into the app. That covers the worker terminal's, the folder terminal's, and
Kane's. Point `config.json` at a folder of them:

```json
{ "roleLibrary": { "path": "C:/Users/you/vault/_meta/agents" } }
```

Each file is frontmatter plus prose. Only three fields matter:

- `role:` is the slug the app looks up. It is **not** the filename, so a role can be renamed for
  display without breaking anything.
- `status:` must be `active`.
- Everything after the frontmatter becomes the prompt.

The three slugs the app asks for are `worker-terminal`, `folder-terminal` and `alpha` (the
overseer).

```markdown
---
role: worker-terminal
status: active
---

## Mission

…
```

Runtime values are **not** templated into the prose, so there are no `{{placeholders}}`. The app
appends them as a `## Session facts` block:

- for a worker: repo, branch and worktree
- for a folder target: folder and working directory
- for Kane: the floor's targets, coordination dir and overseer name

That keeps the file as readable prose that a person edits.

Files are read **at session start**, so restart a terminal to pick up an edit; a running session
keeps the text it was given. Every failure falls back to the compiled-in prompt: no key
configured, a missing folder, an unreadable file, no file with that slug, or a role that isn't
`active`. A session that starts with *no* instructions is far worse than one running a slightly
stale default. Each start logs one line naming the slug and the source:

```
[roles] worker-terminal — vault (Worker Terminal.md)
[roles] alpha — built-in (no roleLibrary configured)
```

Parsing lives in `src/terminals/role-library.ts` (pure, tested) with the file reads in
`src/terminals/role-loader.ts`.

### 📖 Roles: the agent instruction interface

The **📖 Roles** button in the top bar opens a full-window, read-only wiki of that library. There
is one tile per role, grouped by surface, showing:

- the rung it declares
- its status
- the first paragraph of its `## Mission`
- when the Custodian last reviewed it

You can filter by surface, authority rung or status, and search across name, mission and scope
text. Clicking a tile opens the `.md`: in Obsidian when the library sits inside a vault (the app
walks up looking for a `.obsidian/` folder), otherwise in the OS default app. 📁 reveals it in
Explorer. Leaving the view puts your workspaces back exactly as they were.

Nothing in the view edits anything. The vault is the one writer over these files, and an edit
surface here would be a second one. Two things follow from that:

- **Un-migrated roles** are agents that exist only as a string literal in some app's source or in a
  scheduled-task config. The view reads them from the registry table in `Index.md` beside the role
  files. They are a filter of their own, off by default, and each renders the steps to migrate it.
  A coverage count ("8 of 14 roles have a role file") says more about the health of the library
  than any single tile.
- The one action that changes anything is library-level: **Review with Custodian** spawns a
  terminal on the `agent-custodian` role, in the library folder. It is offered only when that role
  file exists and is `status: active`. A session that fell back to the generic folder-terminal
  prompt would look like a Custodian without being one.

View logic is pure and tested in `src/terminals/role-view.ts`, the folder read in
`src/terminals/role-view-loader.ts`, and the DOM in `src/ui/roles-view.ts`. The view reads the
library through the same parser a session start uses. If it parsed the folder its own way, the
view and the running sessions could disagree about what a role says, and the view is the one
you'd trust.
