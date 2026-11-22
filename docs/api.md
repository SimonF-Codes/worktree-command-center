---
status: stable
---

# External API — the connector channel

A local process that is **not** the app and **not** Kane can read a workspace's floor and ask it to
do work. It might be a plain `claude` session in another folder, a script, or another desktop app
on the same machine. There are three pieces:

| piece | direction | what it is |
| --- | --- | --- |
| [`floor/state.json`](#floor-state--floorstatejson) | read | who is on the floor right now, as JSON |
| [requests and receipts](#requests-and-receipts) | write, then read | `spawn` a new terminal, `tell` a live one, or open a [`new-tab`](#new-tab-a-workspace-tab-bound-to-a-repo) (granted connectors only) |
| [`wcc-client`](#the-client--wcc-client) | both | a CLI that wraps the two above |

A session **inside** the app reaches the same `new-tab` through `cos-coord new-tab`, Kane's own
channel. Both are documented together under [new-tab](#new-tab-a-workspace-tab-bound-to-a-repo).

Everything here is a contract. A field that changes meaning or disappears is a version bump (`v`),
not a refactor. Additive fields keep the version.

How this differs from Kane's own channel, and why, is in
[architecture.md](architecture.md#two-ways-in-god-outbox-and-connectors).

## Where things live

Each workspace has its own **coordination directory**:

```
<userData>/.coordination/<workspaceId>/
```

`<workspaceId>` is the `id` from `config.json`'s `workspaces` list. `<userData>` is:

| platform | `<userData>` |
| --- | --- |
| Windows | `%APPDATA%\worktree-command-center` |
| macOS | `~/Library/Application Support/worktree-command-center` |
| Linux | `$XDG_CONFIG_HOME/worktree-command-center` (default `~/.config/…`) |

`config.json` sits directly in `<userData>`.

## Registering a connector

A connector is identified by a slug (`[a-z0-9-]`), e.g. `brain-2-0`. Before any request from it
is honoured, it must be listed in `config.json`:

```json
{ "connectors": [{ "id": "brain-2-0", "label": "Brain 2.0", "grants": ["new-tab"] }] }
```

`id` and `label` are required, and an entry missing either is ignored. `grants` is optional and
lists the verbs beyond `spawn`/`tell` this connector may use; today the only one is `"new-tab"`.
Unknown grant names are dropped. This is a **local trust boundary
between the user's own apps, not authentication**. A request from an id that isn't registered is
still answered, with a rejected receipt, so a misconfigured caller finds out at once.

Registration is checked against the **directory** the request was dropped in
(`connectors/<id>/`), which is the identity the app trusts. The envelope's `connector` field must be
present but is not what's checked.

`config.json` is read at launch, so restart the app after adding a connector.

## What a connector may do

**`spawn` and `tell`, plus `new-tab` when granted, nothing else.** Not `watch`, `rename`, `close`
or `personality`: those act on the operator's own workspace (Kane's watchers, Kane's mode), not on
requesting work, so they stay the overseer's alone.

`new-tab` is a bigger grant than `spawn`, so registration alone does not give it. It does three
things a spawn cannot: it adds a tab to the operator's window, it registers a new target that
later `spawn` requests can reach, and it can create a folder on disk. The folder is the smallest
of the three. Any local process running as the user can already `mkdir` and `git init`, and the
app is not a sandbox. The tab and the registration are the app's to give, so:

- it must be granted by name, per connector (`"grants": ["new-tab"]`);
- an ungranted request is answered with a rejected receipt that names the fix, never ignored;
- every tab it makes is announced in the window, saying which connector asked, with an **Open**
  button. The active tab is never switched under the operator;
- it never writes into an existing folder, and never takes a name already on the floor.

That is the honest boundary: it stops a connector from changing the operator's window or floor
without being granted to, and makes whatever it does visible. It does not stop a local process
from writing files, and nothing here could.

`tell` may address **any** live terminal by its exact name, but only one that already exists. It
can't create, rename or retarget one, and an ambiguous name or a journal is rejected rather than
guessed at. Messages are capped at 4000 characters, because a paste-expanded message has jammed a
terminal's input before. The backstop against a connector spamming the floor is that **every
attempt gets a receipt**, with a reason when it didn't land, so misbehaviour is visible at once.
There is no separate rate limit, and `spawn` has never had one.

## Floor state — `floor/state.json`

```
<coordDir>/floor/state.json
```

The live roster as JSON. The app writes it in the **same pass** that writes `floor/INDEX.md` (the
markdown roster Kane reads) and the per-terminal `floor/<id>-<name>.md` snapshots, so the two
can't disagree. It is rewritten every `intervalMs` (4 s), temp-file-then-rename, so a reader never
sees half a file.

**When it is written:** while that workspace has an overseer console (Kane) open, which is
the same lifetime the floor snapshots have always had. Kane reopens with the app, so in practice
that's whenever the app is running with Kane docked. A file whose `ts` is more than a few
intervals old means nothing is refreshing it: the app was closed, or no Kane is open there.
Judge staleness against `intervalMs`, not a hard-coded number. Requests are drained either way;
only the roster depends on Kane.

### Top level

| field | type | meaning |
| --- | --- | --- |
| `v` | `1` | format version |
| `workspaceId` | `string` | the workspace this floor belongs to |
| `ts` | `number` | when this snapshot was taken (epoch ms) |
| `intervalMs` | `number` | how often the app rewrites the file |
| `terminals` | `Terminal[]` | every live session, in floor order, then overseer consoles |
| `worktrees` | `{ scannedAt, entries }` | the worktree ledger, see below |

### `Terminal`

| field | type | meaning |
| --- | --- | --- |
| `id` | `number` | tile id; `0` and negative numbers are overseer consoles |
| `name` | `string` | exact live name, the value `tell` addresses |
| `kind` | `"terminal" \| "journal" \| "god"` | a worktree/folder session, a journal tile, or an overseer console |
| `repo` | `string \| null` | repo (or folder target) name; null unless `kind` is `terminal` |
| `branch` | `string \| null` | the worktree's branch |
| `worktreePath` | `string \| null` | absolute path of its worktree |
| `busy` | `boolean \| null` | true mid-turn, false idle; null where the app doesn't track it (journals, overseers) |
| `hidden` | `boolean` | minimized off the stage (still a live session) |
| `tellable` | `boolean` | whether a connector `tell` can reach it, which is exactly `kind === "terminal"` |
| `snapshotFile` | `string \| null` | the recent-output snapshot beside this file (`floor/<snapshotFile>`) |

Overseer consoles are listed so you can see they exist. They are never on the connector's `tell`
roster.

### `worktrees`

The same ledger `worktrees.md` renders, from the app's last worktree scan. That scan runs on its own
30 s cadence, and no extra scan is run to write this file, so it carries its own timestamp:

| field | type | meaning |
| --- | --- | --- |
| `scannedAt` | `number \| null` | when the scan finished; **null = no scan yet this launch**, which is not the same as "no worktrees" |
| `entries[].repo` | `string` | |
| `entries[].branch` | `string` | |
| `entries[].path` | `string` | absolute worktree path (primary checkouts are never listed) |
| `entries[].terminal` | `string \| null` | the live terminal holding it, or null if nobody is |
| `entries[].state` | `"clean" \| "dirty" \| "ahead" \| "parked"` | first that applies: parked (HEAD is an auto-park `wip:` commit), dirty, ahead of base, clean |
| `entries[].dirtyFiles` | `number` | uncommitted files |
| `entries[].ahead` / `behind` | `number` | commits against `base` |
| `entries[].base` | `string \| null` | the ref those count against; equal to `branch` when no base could be told |
| `entries[].lastCommitAt` | `number \| null` | HEAD's commit time (epoch ms) |

### Example

```json
{
  "v": 1,
  "workspaceId": "default",
  "ts": 1792036800000,
  "intervalMs": 4000,
  "terminals": [
    { "id": 3, "name": "ax-a1--migrate", "kind": "terminal", "repo": "app", "branch": "wt/main-3",
      "worktreePath": "C:\\dev\\.claude-worktrees\\app\\wt-main-3", "busy": true, "hidden": false,
      "tellable": true, "snapshotFile": "3-ax-a1-migrate.md" },
    { "id": 4, "name": "notes", "kind": "journal", "repo": null, "branch": null, "worktreePath": null,
      "busy": null, "hidden": false, "tellable": false, "snapshotFile": null },
    { "id": 0, "name": "Kane", "kind": "god", "repo": null, "branch": null, "worktreePath": null,
      "busy": null, "hidden": false, "tellable": false, "snapshotFile": null }
  ],
  "worktrees": {
    "scannedAt": 1792036790000,
    "entries": [
      { "repo": "app", "branch": "wt/main-3", "path": "C:\\dev\\.claude-worktrees\\app\\wt-main-3",
        "terminal": "ax-a1--migrate", "state": "dirty", "dirtyFiles": 2, "ahead": 1, "behind": 0,
        "base": "main", "lastCommitAt": 1792036000000 }
    ]
  }
}
```

## Requests and receipts

```
<coordDir>/connectors/<connectorId>/requests/   you write requests here
<coordDir>/connectors/<connectorId>/receipts/   the app writes one receipt per request here
```

Create the directories if they don't exist; the app watches all of `connectors/` recursively.

### Writing a request

Write it **atomically**, as a temp file in `requests/` renamed over the final name. Only names
ending in `.json` are picked up, so a `.tmp` file is never read half-written:

```js
const fs = require('fs'), path = require('path');
const id = require('crypto').randomUUID();
const reqDir = path.join(coordDir, 'connectors', 'brain-2-0', 'requests');
fs.mkdirSync(reqDir, { recursive: true });
const body = { v: 1, id, connector: 'brain-2-0', sentMs: Date.now(), kind: 'spawn',
  repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null };
const tmp = path.join(reqDir, `.${id}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(body));
fs.renameSync(tmp, path.join(reqDir, `${id}.json`));
```

The app drains a request by moving it into `requests/.done/`, and acts on it only once that move
has succeeded. So a caller that gives up waiting can **withdraw** a request it has not seen
drained by deleting the file. If the delete succeeds, the app never took it and never will. If
the delete fails because the file is gone, the app took it first. `wcc-client` does exactly this.

### Envelope (every request)

| field | type | |
| --- | --- | --- |
| `v` | `number` | send `1` |
| `id` | `string` | your own unique id. The receipt is named after it and echoes it. Use a UUID |
| `connector` | `string` | your connector id (required; identity is the directory, see above) |
| `sentMs` | `number` | when you sent it (epoch ms) |
| `kind` | `"spawn" \| "tell" \| "new-tab"` | `new-tab` needs the grant; its fields are under [new-tab](#new-tab-a-workspace-tab-bound-to-a-repo) |

### `spawn`: open a new worktree terminal

| field | type | |
| --- | --- | --- |
| `repo` | `string` | a repo or folder target on this workspace's floor, matched case-insensitively. **Required** |
| `task` | `string` | the first instruction, typed into the new session. **Required** |
| `base` | `string \| null` | branch to cut the worktree from; null = the repo's default branch. Ignored for folder targets |
| `model` | `string \| null` | Claude model for the session; null = the workspace toolbar's current model |
| `effort` | `string \| null` | one of `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`; null = the workspace toolbar's current effort |
| `name` | `string \| null` | display name for the tile; null = generated |

### `tell`: type a message into a live terminal

| field | type | |
| --- | --- | --- |
| `terminal` | `string` | exact live name from `state.json` (`tellable: true`). Case-insensitive if that is unambiguous. **Required** |
| `message` | `string` | at most 4000 characters. **Required** |

```json
{ "v": 1, "id": "…", "connector": "brain-2-0", "sentMs": 0, "kind": "tell",
  "terminal": "ax-a1--migrate", "message": "run the migration script and report back" }
```

A `tell` into a terminal that's mid-task is still accepted. It is typed into the terminal the way
Kane's own `tell` is, and a running Claude Code session queues it. **`accepted` means "typed and
submitted", confirmed on the target's screen**, not "acted on". The app retries delivery for up to
~40 s against a target that can't take input right now (e.g. mid-`/compact`). It also never types
over unsubmitted text someone left in that terminal's input box. Until it's settled, no receipt
exists yet: poll for it, and don't read its absence as failure.

### Receipt

For every request that carried an `id`, the app writes `receipts/<id>.json`. Characters outside
`[A-Za-z0-9_-]` in the id are replaced with `_` in the filename, so plain UUIDs map one-to-one.

| field | type | |
| --- | --- | --- |
| `v` | `1` | |
| `id` | `string` | the request's `id` |
| `status` | `"accepted" \| "rejected"` | |
| `terminalName` | `string` | on `accepted` `spawn`/`tell`: the terminal a `spawn` created or a `tell` was delivered into |
| `newTab` | `NewTabResult` | on `accepted` `new-tab`: see [its result](#the-result-newtabresult) |
| `leftOnDisk` | `string` | on `rejected` `new-tab` only, and only when a folder **was** created (its initial commit failed) |
| `reason` | `string` | on `rejected`: always present, human-readable |
| `handledMs` | `number` | when the app settled it |

```json
{ "v": 1, "id": "…", "status": "accepted", "terminalName": "bx-a1--thing", "handledMs": 1788363509001 }
{ "v": 1, "id": "…", "status": "rejected", "reason": "unknown repo \"ghost\". Known: app, notes", "handledMs": 1788363509001 }
```

Receipts are yours to delete once read. The app prunes any older than 7 days so the directory
can't grow forever.

### Every reject reason

Checked in this order. A request with no recoverable `id` gets **no receipt**, because there is
nothing to name one after. Those are the first three rows.

| when | `reason` |
| --- | --- |
| file is not JSON | `malformed request — invalid JSON` *(no receipt)* |
| JSON but not an object | `malformed request — not a JSON object` *(no receipt)* |
| no `id` | `malformed request — missing "id"` *(no receipt)* |
| no `connector` | `malformed request — missing "connector"` |
| no numeric `v` | `malformed request — missing "v"` |
| no numeric `sentMs` | `malformed request — missing "sentMs"` |
| any other `kind` | `kind "<kind>" is not permitted for connectors — only "spawn", "tell" or "new-tab" is` |
| new-tab: a field check fails | one of the [field reasons](#every-new-tab-reason-in-order), rows 1–10 |
| tell without `terminal`/`message` | `malformed tell request — "terminal" and "message" are required` |
| tell message over 4000 chars | `message is too long (<n> chars, max 4000) — trim it before sending` |
| spawn without `repo`/`task` | `malformed spawn request — "repo" and "task" are required` |
| directory id not in `config.json` | `connector "<id>" is not registered` |
| new-tab: no `"new-tab"` in the entry's `grants` | `connector "<id>" is not granted "new-tab" — add "grants": ["new-tab"] to its entry in config.json and restart the app` |
| new-tab: anything after that | the [app-side reasons](#every-new-tab-reason-in-order), rows 11 on |
| tell: no such name | `no such terminal "<name>". Live: <names>` |
| tell: case-insensitive match hits several | `"<name>" is ambiguous — matches <names>` |
| tell: target is a journal | `"<name>" is a journal tile, not a terminal — it can't accept a message` |
| spawn: repo not on the floor | `unknown repo "<repo>". Known: <names>` |
| spawn: bad effort | `invalid effort "<effort>". Valid: low, medium, high, xhigh, max, ultracode` |
| tell: target closed after it was resolved | `"<name>" is no longer a live terminal` |
| tell: target closed while queued | `the terminal closed before this message could be delivered` |
| tell: session ended | `the terminal is not running` |
| tell: input box held by someone's typing | `not accepted within 40s — someone has unsubmitted typing in its input box — it was NOT typed over` |
| tell: session couldn't take input | `not accepted within 40s — the session may be unable to take input right now (e.g. mid-/compact)` |
| spawn: worktree or session failed to start | `couldn't spawn in repo "<repo>" — see the app's toast for detail` |

Registration is checked right after the envelope parses, before any lookup. So an unregistered
connector never learns the floor's repo list or terminal roster from a reason string, and an
ungranted one never learns anything a `new-tab` lookup would tell it.

The source of truth is `parseConnectorRequest` / `evaluateConnectorRequest` /
`resolveConnectorTellTarget` in `src/terminals/connectors.ts` and their tests
(`tests/connectors.test.ts`). The delivery-time reasons come from `handleConnectorRequest` and
`attemptTellDelivery` in `src/terminals/terminals-grid.ts`.

### When it's drained

Every configured workspace's grid is built at app launch, and each arms its connector watcher in its
constructor. So a `spawn` into a workspace nobody has opened this launch works at once. If the
app isn't running, requests wait in `requests/` until it is, unless you withdraw them.

## The client — `wcc-client`

`wcc-client` wraps all of the above: it writes the envelope atomically, blocks on the receipt,
deletes the receipt, and withdraws a request the app never picked up. It ships in `pty-sidecar/`
next to `cos-coord`, so it comes with the installed app. It needs only `node` on PATH.

It is a **connector**, not a loosened `cos-coord`. It never writes `god-outbox/`, and the app still
decides whether its connector id is registered.

### Putting it on PATH

The directory to add:

| install | directory |
| --- | --- |
| Windows, installed app | `%LOCALAPPDATA%\Programs\worktree-command-center\resources\pty-sidecar` |
| macOS, installed app | `/Applications/Worktree Command Center.app/Contents/Resources/pty-sidecar` |
| a source checkout | `<repo>/pty-sidecar` |

`wcc-client.cmd` serves cmd/PowerShell and `wcc-client` serves sh. Sessions the app spawns already
have this directory on PATH (that's how they find `cos-coord`), so `wcc-client` works there too,
though an in-app session has no reason to use it. Without PATH, run
`node <dir>/wcc-client.cjs …`.

### Configuration

| | flag | env | |
| --- | --- | --- | --- |
| which floor | `--coord-dir <dir>` | `WCC_COORD_DIR` | the coordination directory itself |
| … or | `--workspace <id>` | `WCC_WORKSPACE` | resolved under the default `<userData>` (override with `WCC_USER_DATA`) |
| who you are | `--connector <id>` | `WCC_CONNECTOR` | required for `spawn`/`tell`, not for `floor` |
| how long to wait | `--wait-ms <ms>` | `WCC_WAIT_MS` | default 60000 |

A flag beats its env var, and `--coord-dir` beats `--workspace`. There is no default workspace,
because talking to the wrong floor is worse than being asked to pick one. Unknown flags are an
error, so a misspelt `--efort` can't silently spawn at the default effort. `--` ends flag parsing.

### Commands

```
wcc-client floor [--json]
wcc-client spawn <repo> --task "<task>" [--base <branch>] [--model <m>] [--effort <e>] [--name <n>]
wcc-client tell <terminal> "<message>"
wcc-client new-tab "<tab name>" [--repo <target>]
wcc-client new-tab "<tab name>" [--new-repo <name>] [--parent <dir>] [--base <branch>]
                   [--gitignore general|node|python|none] [--claude-md|--no-claude-md]
                   [--remote none|private|public] [--json]
```

- **`floor`** prints one line per session from `state.json`, or the file itself with `--json`. A
  snapshot older than three intervals still prints, with a warning on stderr. A missing file
  exits 2.
- **`spawn`** and **`tell`** print the receipt's `terminalName` alone on stdout, so
  `name=$(wcc-client spawn …)` works.
- **`new-tab`** prints the new tab's workspace id alone on stdout (`--json`: the whole
  [result](#the-result-newtabresult)), and the details and any warnings on stderr. Its default
  wait is 120000 ms, not 60000. See [new-tab](#new-tab-a-workspace-tab-bound-to-a-repo).
- A flag that belongs to a different command (`spawn … --repo x`, `new-tab … --task y`) is an
  error, not ignored.

### Exit codes

| code | meaning | safe to retry? |
| --- | --- | --- |
| `0` | accepted; the terminal name is on stdout | — |
| `2` | rejected (the app's `reason` on stderr), bad usage, or **withdrawn**: the app never picked the request up within the wait, so it was deleted and nothing will happen | yes, after fixing the cause |
| `3` | the app took the request but sent no receipt within the wait. **It may still happen** | no: check `floor` first. A blind retry of a `spawn` can open two terminals |
| `4` | `new-tab` only: it failed, **but a repo folder was created** (its initial commit failed). The path is on stderr | no: fix the cause, commit in that folder, then `new-tab … --repo <name>` |

### End to end

Once `config.json` lists `{ "id": "my-agent", "label": "My agent" }` and the app has been
restarted, an outside session can do this:

```sh
export WCC_WORKSPACE=default WCC_CONNECTOR=my-agent

wcc-client floor
# floor default — snapshot 1s old
#   ax-a1--migrate  app · wt/main-3  busy
#   Kane  god  -  (not tellable)

name=$(wcc-client spawn app --task "Add a /health endpoint and a test for it" --effort high) \
  || exit $?
echo "spawned $name"

wcc-client tell "$name" "When you're done, also update the API docs." \
  || echo "not delivered (exit $?)"
```

PowerShell:

```powershell
$env:WCC_WORKSPACE = 'default'; $env:WCC_CONNECTOR = 'my-agent'
$name = wcc-client spawn app --task "Add a /health endpoint and a test for it"
if ($LASTEXITCODE -eq 0) { wcc-client tell $name "Also update the API docs." }
```

The same thing without the client takes three steps: write the envelope as in
[Writing a request](#writing-a-request), poll `receipts/<id>.json` until it exists, then read
`status`.

## new-tab: a workspace tab bound to a repo

A session asks the app for a new **workspace tab** that is already linked to a repo. If it names
a registered target, the tab is bound to that one. If it names none, the app **creates** a fresh
repo and binds the tab to it. The repo gets a folder, `git init -b <base>`, a README, the seed
files, an **initial commit**, and optionally a GitHub remote. The tab then opens on that repo with
its branch selected, exactly as if you had used **+** → **🆕 New repo…** in the window.

The initial commit is not optional. Every terminal here is a git worktree, and a worktree can't
branch from a repo with no commits. So a repo that ends up without one is reported as a failure
(exit 4, `leftOnDisk`), never as a success with a footnote.

### Which channel

| caller | channel | command | authority |
| --- | --- | --- | --- |
| Kane, the overseer console inside the app (`COS_ROLE=god`) | `god-outbox/`, Kane's own | `cos-coord new-tab …` | the overseer's; refused without `COS_ROLE=god` |
| anything **outside** the app: a plain `claude` session, a script, another app | `connectors/<id>/requests/` | `wcc-client new-tab …` | a registered connector **with** `"grants": ["new-tab"]` |

A worker terminal inside the app has neither. Opening tabs is not part of one task's worth of
authority, so `cos-coord new-tab` refuses it like `spawn`. If a worker really needs to, register a
connector for it and use `wcc-client`. That makes the decision a line in `config.json` rather than
an accident.

Both channels end in the **same app code** as the window's own buttons: `planNewTab`
(`src/new-tab.ts`) decides, `createRepoFromParams` → `instantiateRepo` (`src/instantiate-repo.ts`)
makes the repo, and `openLinkedTab` adds the tab. The 🆕 form goes through `createRepoFromParams`
too, and refuses the same things through the same `newRepoRefusal`. Neither path can accept
something the other refuses.

A tab a session made is **announced** in the window: who asked, the tab, the repo, any warnings,
and an **Open** button. The tab you're on is left alone.

### Request fields

On the connector channel these sit in the [envelope](#envelope-every-request) with
`"kind": "new-tab"`. On Kane's channel `cos-coord` writes the same fields itself. Every optional
field is `null` when unset, never absent.

| field | type | CLI flag | |
| --- | --- | --- | --- |
| `name` | `string` | the positional | the tab's display name, at most 80 characters. **Required** |
| `repo` | `string \| null` | `--repo` | an existing registered target, matched case-insensitively. Excludes every field below |
| `newRepo` | `string \| null` | `--new-repo` | the repo to create. With `repo` also null, the repo is named after the tab. The folder name is the name with anything outside `[A-Za-z0-9._-]` turned into `-` |
| `parent` | `string \| null` | `--parent` | absolute folder to create it in. null = where the 🆕 form would propose: beside the last repo created, else beside the first registered git repo. The CLIs resolve a relative `--parent` against **their own** working directory |
| `base` | `string \| null` | `--base` | the base branch, cut at `git init`. null = `main` |
| `gitignore` | `"general" \| "node" \| "python" \| "none" \| null` | `--gitignore` | null = `general` |
| `claudeMd` | `boolean \| null` | `--claude-md` / `--no-claude-md` | seed a `CLAUDE.md`. null = yes |
| `remote` | `"none" \| "private" \| "public" \| null` | `--remote` | a GitHub repo through `gh`, added as `origin` and pushed. null = `none` |

These are the initial parameters from `src/new-repo-params.ts`, the same set the 🆕 form shows,
with the same defaults. Each is there because it's awkward to change after the first commit,
which is the commit every worktree branches from.

```json
{ "v": 1, "id": "…", "connector": "my-agent", "sentMs": 0, "kind": "new-tab",
  "name": "Site", "repo": null, "newRepo": "site", "parent": "C:\\dev", "base": null,
  "gitignore": "node", "claudeMd": null, "remote": "private" }
```

### The result: `NewTabResult`

On success it's in the connector receipt's `newTab` field and on Kane's receipt. `--json` prints
it.

| field | type | |
| --- | --- | --- |
| `workspaceId` | `string` | the new tab's id. It is the `--workspace` / `WCC_WORKSPACE` that reaches it, and what the CLIs print on stdout |
| `tab` | `string` | its display name |
| `repo` | `string` | the bound target's name, the one `spawn` takes |
| `repoPath` | `string` | its absolute path |
| `branch` | `string \| null` | the branch its toolbar opens on: the new repo's base, or null for an existing target |
| `created` | `boolean` | true when a repo was created, false when an existing one was bound |
| `coordDir` | `string` | the new tab's coordination directory |
| `remoteUrl` | `string \| null` | the GitHub URL when a remote was created |
| `warnings` | `string[]` | what was asked for and didn't happen, e.g. no `gh` (see below). Empty when everything did |

### `gh` missing, or the remote failing

A remote is the one part that **degrades instead of failing**. The local repo is what the tab
needs, and a remote can be added by hand later. `gh` is looked for on `PATH`, then under
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin` (a per-user winget install, which is
**not** on `PATH`), then `Program Files\GitHub CLI`. If it isn't found anywhere, the repo, commit,
registration and tab all happen, `remote` is treated as `none`, and `warnings` says:

```
no GitHub remote: the GitHub CLI (gh) was not found on PATH, under %LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin, or in Program Files\GitHub CLI — the repo was created locally; add a remote later with `gh repo create`
```

If `gh` is found but `gh repo create` fails (not logged in, name taken, offline), it's the same:
success, with `the GitHub remote failed: <gh's own line>. The local repo is fine — add a remote
later with \`gh repo create\`` in `warnings`.

### Every new-tab reason, in order

The same order on both channels. Rows 1–10 are field checks. On the connector channel they come
before registration (like spawn's field checks) and reveal nothing about the floor. Rows 11 on run
in the app, after registration and the grant. Two requests are planned and run one at a time,
so two requests for one name can't both pass row 16.

| # | when | `reason` |
| --- | --- | --- |
| 1 | no `name` | `malformed new-tab request — "name" (the tab name) is required` |
| 2 | `name` over 80 chars | `tab name is too long (<n> chars, max 80)` |
| 3 | `repo` and `newRepo` both set | `"repo" and "newRepo" are mutually exclusive — name an existing target or a repo to create, not both` |
| 4 | a creation field beside `repo` | `"<field>" only applies when creating a repo — it was sent with "repo" (an existing target)` |
| 5 | bad `gitignore` | `invalid gitignore "<x>". Valid: general, node, python, none` |
| 6 | bad `remote` | `invalid remote "<x>". Valid: none, private, public` |
| 7 | `claudeMd` not a boolean | `"claudeMd" must be true, false or null` |
| 8 | `parent` not absolute | `parent "<p>" is not an absolute path` |
| 9 | bad `base` | `"<b>" is not a valid git branch name` |
| 10 | nothing to name the folder after | `repo name "<x>" has no letter or number to make a folder name from` (or, naming the tab: `… — pass "newRepo"`) |
| 11 | `repo`: no such target | `unknown repo "<x>". Known: <names>` |
| 12 | `repo`: the name is shared by several targets | `"<x>" is ambiguous — <n> registered targets share that name (<paths>). Two checkouts cannot both own one name: forget or repoint one in Settings → Targets first` |
| 13 | `repo`: grouped to another tab | `"<x>" belongs to the tab "<group>" — a target grouped to one tab cannot be linked to another` |
| 14 | `repo`: its folder is gone | `"<x>" is registered at <path>, but that folder no longer exists — repoint or forget it in Settings → Targets` |
| 15 | new: no `parent` and nothing to default it from | `no parent folder — pass "parent"; no repo is registered yet to put a new one beside` |
| 16 | new: the name is already a target | `a target named "<x>" is already registered (<path>) — two checkouts cannot both own one name; pick another name, or use the existing target` |
| 17 | new: `parent` doesn't exist | `parent folder <p> does not exist — create it first; a new repo never creates the folders above it` |
| 18 | new: `parent` is a file | `parent <p> is a file, not a folder` |
| 19 | new: target folder exists, with content | `<path> already exists and has content — a new repo is never written into an existing folder` |
| 20 | new: target folder exists, empty | `<path> already exists (empty) — a new repo only goes in a folder that is not there yet; remove it or pick another name` |
| 21 | new: target is a file | `<path> already exists as a file` |
| 22 | new: git has no identity | `git has no identity (user.name / user.email), so the initial commit would fail and no worktree could branch from the repo — nothing was created. Fix: git config --global user.name "Your Name" && git config --global user.email "you@example.com"` |
| 23 | new: `git init` / `mkdir` failed | git's or the OS's own first line |
| 24 | new: the initial commit failed anyway | `created <path>, but its initial commit failed (<git's line>) — a worktree cannot branch from a repo with no commits, so no tab was made. It is registered as "<name>". Fix the cause (usually: git config --global user.name / user.email), commit in <path>, then: new-tab "<tab>" --repo <name>` **with `leftOnDisk`, exit 4** |
| 25 | the app couldn't add the tab | `the tab could not be added` |

Row 22 is checked **before anything is written**, with `git var GIT_AUTHOR_IDENT` /
`GIT_COMMITTER_IDENT` run in the parent folder. These fail by the same rule `git commit` does. One
case can't be decided from outside the repo: identity that comes only from an
`includeIf "gitdir:…"`. When git has any conditional include, the probe stands aside, and the
commit decides (row 24).

Withdrawal isn't a reason, because nothing reached the app. It's exit 2 from the CLI, below.

Source of truth: `parseNewTabFields`, `planNewTab`, `newRepoRefusal` in `src/new-tab.ts`;
`instantiateRepo` in `src/instantiate-repo.ts`; `newTabFromSessionNow` in `src/app.ts`. Tests:
`tests/new-tab.test.ts`, `tests/instantiate-repo.test.ts` (real git, temp folders),
`tests/new-tab-cli.test.ts` (both CLIs end to end).

### Exit codes (both CLIs)

| code | meaning | safe to retry? |
| --- | --- | --- |
| `0` | the tab exists. Workspace id on stdout, details and warnings on stderr | — |
| `2` | refused (reason on stderr), bad usage, not the overseer (`cos-coord`), or **withdrawn**: nobody drained it within the wait, so the CLI deleted the request and **nothing will happen, ever** | yes, after fixing the cause |
| `3` | the app took it and didn't answer within the wait. **It may still happen** | no: look at the tab bar first |
| `4` | it failed **after creating a folder**: the repo exists and is registered, without its initial commit. The path is on stderr | no: commit in that folder, then `new-tab "<tab>" --repo <name>` |

**Withdrawal** is what keeps a request from firing hours later. Both drains, `god-outbox/` and
`connectors/`, claim a request by renaming it into `.done/` **before** acting on it. The CLI
withdraws by deleting the file. Exactly one of the two succeeds. If the delete wins, the app never
had it. If the rename won, the CLI reports exit 3, not 2.

| | env | default |
| --- | --- | --- |
| `cos-coord new-tab` wait | `COS_COORD_NEW_TAB_WAIT_MS` | 120000 |
| `wcc-client new-tab` wait | `--wait-ms` / `WCC_WAIT_MS` | 120000 |

`cos-coord new-tab` is the one `cos-coord` command that never fails open. Without
`COS_COORD_DIR`, or on an unexpected error, it exits 2 rather than 0.

### End to end: from outside

`config.json`, then restart the app:

```json
{ "connectors": [{ "id": "my-agent", "label": "My agent", "grants": ["new-tab"] }] }
```

```sh
export WCC_WORKSPACE=default WCC_CONNECTOR=my-agent

# A fresh repo named after the tab, in C:\dev, Node .gitignore, private GitHub remote:
ws=$(wcc-client new-tab "Recipe Site" --parent C:/dev --gitignore node --remote private) || exit $?
# stderr: tab "Recipe Site" (workspace recipe-site) on Recipe-Site — C:\dev\Recipe-Site, created on branch main
#         coord dir: C:\Users\…\worktree-command-center\.coordination\recipe-site
#         warning: no GitHub remote: the GitHub CLI (gh) was not found …     ← only when gh is absent

# Start the first terminal in it. The repo name is the folder name:
wcc-client --workspace "$ws" spawn Recipe-Site --task "Scaffold a Vite + TypeScript app and commit it"

# Or bind a tab to a repo already on the floor:
wcc-client new-tab "API work" --repo app
```

PowerShell:

```powershell
$env:WCC_WORKSPACE = 'default'; $env:WCC_CONNECTOR = 'my-agent'
$ws = wcc-client new-tab "Recipe Site" --parent C:\dev --gitignore node
switch ($LASTEXITCODE) {
  0 { wcc-client --workspace $ws spawn Recipe-Site --task "Scaffold the app" }
  4 { Write-Warning 'Repo created without its initial commit - set git user.name/user.email, commit, then use --repo' }
  default { Write-Warning "new-tab did not happen (exit $LASTEXITCODE)" }
}
```

### End to end: Kane

```sh
ws=$(cos-coord new-tab "Recipe Site" --gitignore node) || exit $?
# start a terminal in the new tab, through that tab's own outbox:
COS_COORD_DIR="$(dirname "$COS_COORD_DIR")/$ws" cos-coord spawn Recipe-Site --task "Scaffold the app"
```

`cos-coord spawn` without that override would open the terminal in **Kane's own** tab. Every
tab's coordination directory sits next to the others under `.coordination/`.

## `cos-coord` inside the app: environment and verbs

This section is the in-app channel's own reference: what a session the app opened is given, and
what each `cos-coord` verb it may run sends and answers. The connector channel above is for
processes **outside** the app.

### Environment

Each spawn path sets exactly the `COS_*` it means, in its own environment block. None is ever
inherited from the app's environment: `src/terminals/session-env.ts` strips every `COS_*`, since
worker tiles once inherited `COS_ROLE=god` and ran with god authority.

| variable | set for | value | used for |
| --- | --- | --- | --- |
| `COS_COORD_DIR` | every session | the workspace's coordination directory | where every request, lock and note goes |
| `COS_TERMINAL_ID` | every session | a tile id (`0` for the primary Kane, `-N` for a duplicate). **Reissued every launch**, and repeated across tabs | ownership of this workspace's explicit `cos-coord acquire` locks within one run |
| `COS_TERMINAL_NAME` | every session | the tile's display name | board and chat attribution |
| `COS_ROLE` | Kane consoles only | `god` | which channel `tell` and `spawn` go to (Kane's `god-outbox/`, or else the session's own [request directory](#managers-session-requests-and-spawn-proposals)), and the gate on `watch`, `rename`, `close`, `personality`, `new-tab`. **The app never reads it**: a manager's authority comes from its role file |
| `COS_SESSION_ID` | every terminal and Kane console | the session's `sessionId`: a uuid minted once and **stable across restarts** | the `from` on every outbox request (attribution only), the **owner of a write lease** — see [Write claims](#write-claims-the-lease-and-the-write-hook) — and which `sessions/<id>/` directory a session request is dropped in |
| `COS_ISOLATION` | sessions with an isolation mode (repo spawns since step 8) | `worktree`, `shared-readonly`, `shared-write` or `scratch` | the write hook's **failure policy** (open for `worktree`, closed otherwise) and its rules |
| `COS_CHECKOUT` | the same | the checkout the write gate is about: the session's worktree, or the shared checkout | the lease's checkout root |
| `COS_CLAIMS_DIR` | the same | `<userData>/.coordination/_claims` | the machine-wide lease store |
| `COS_ISOLATION_POLICY`, `COS_RUNG`, `COS_TASK_CLASS` | the same (rung and class only when known) | the setting, the rung ceiling and the task class | whether a `shared-readonly` session's first write may escalate |
| `COS_COORD_TELL_WAIT_MS` / `_CLOSE_WAIT_MS` / `_SPAWN_WAIT_MS` / `_NEW_TAB_WAIT_MS` | (caller's override) | milliseconds | how long the verb blocks for the app's receipt. Default 45 s (new-tab: its own) |

### Verb register

From Kane (`COS_ROLE=god`), every request lands in `god-outbox/` as one JSON file and carries `ts`,
`kind` and `from` (the sender's `COS_SESSION_ID`, or `null`). Verbs that block read
`god-outbox/.receipts/<id>.json`. From any other session the app opened, `spawn` and `tell` — and
`assign`, `propose-spawn`, `proposal` — go through that session's own request directory instead;
see [Managers](#managers-session-requests-and-spawn-proposals).

| verb | blocks for a receipt | request fields beyond `ts`/`kind`/`from` | exit codes |
| --- | --- | --- | --- |
| `tell <target> "<message>"` | yes | `target`, `message` | 0 delivered · 2 not delivered (reason on stderr) |
| `watch <target> --note "…"` | no | `target`, `note` | 0 |
| `spawn <repo> --task "…"` | **yes** | `repo`, `base`, `task`, `model`, `effort`, `name`, `workstream`, `role`, `taskClass`, `writes`, `isolation` (each `null` when not given) | 0 spawned · 2 refused, or never picked up and withdrawn · 3 taken but not confirmed |
| `rename <target> --to "…"` | no | `target`, `name` | 0 |
| `close <target>` | yes | `target` | 0 closed · 2 refused or not confirmed |
| `personality` | no | — | 0 |
| `lease` | no | (no request: reads `_claims/`) | 0 |
| `lease release` | no | (no request: releases this session's lease) | 0 released · 2 refused — dirty checkout, no lease held, or not an app session |
| `new-tab "<tab>" …` | yes | see [new-tab](#new-tab-a-workspace-tab-bound-to-a-repo) | see its [exit codes](#exit-codes-both-clis) |

### `spawn`

```sh
cos-coord spawn "<repo>" --task "<first instruction>" [--base <branch>] [--model <alias-or-id>]
  [--effort <level>] [--name "<terminal name>"] [--role <slug>] [--workstream <id>]
  [--class <task-class>] [--writes none|repo|outside] [--isolation <mode>]
```

- `--role <slug>`: the role file the new session runs on, by its `role:` slug. Without it a
  worktree session is a `worker-terminal` and a folder session a `folder-terminal`. The slug is
  **not validated** at spawn: an unknown or non-`active` one falls back to the compiled default,
  and the app logs why (`[roles] …`). Kane's spawns are not refused on it. A session's own
  spawn is: see [Managers](#managers-session-requests-and-spawn-proposals). With `v2.managers`
  on, the team tree does check Kane's edge against the overseer's role file (`alpha`, whose
  `spawns:` lists what it may start): a session Kane opened on a role outside that list still
  runs, but sits in UNASSIGNED, "outside delegation", with the failing condition named.
- `--workstream <id>`: the workstream the session serves. Stored on the session record, and
  otherwise unused for now.
- `--class`, `--writes`, `--isolation`: the session's isolation intent — see
  [Isolation modes](#isolation-modes). Passed through as given; junk reads as absent. They change
  nothing under the default `worktree-always` setting, except that an `observer`/`proposer` role
  is held to its rung ceiling under every policy (below). `--isolation shared-write` is refused
  (exit 2) under every setting but `cheapest-safe`.

It **confirms before returning**. Success prints the new terminal, its branch and its session id:

```
coord: spawned "wt-main-7" on wt/main-7 — session 3f0c…e21a
```

The receipt the app files (`god.ts` `SpawnReceipt`):

```jsonc
{ "ok": true, "spawned": { "terminal": "wt-main-7", "branch": "wt/main-7", "sessionId": "3f0c…e21a", "mode": "worktree" } }
{ "ok": false, "reason": "unknown repo \"ghost\". Known: app, api" }
```

With no receipt inside the window, the CLI tries to take the request back. If it can, the app
never had it: exit 2, `WITHDRAWN`, nothing will spawn. If the app already claimed it: exit 3,
`NOT confirmed`, and it may still appear, so check `floor/INDEX.md` before retrying. An app older
than the CLI files no spawn receipt, so its spawns always end in exit 3.

### Session identity and lineage

The app persists these on each session's record in `<userData>/.terminal-sessions.json`:

| field | written | meaning |
| --- | --- | --- |
| `sessionId` | once, when the session is created. A record from an older build gets one on its first load | stable identity, never re-minted on restore. Tile ids are not stable, and folder sessions share paths |
| `parentSessionId` | at spawn, from the request's `from` | who spawned this session |
| `workstreamId` | at spawn, from `--workstream` | the group of work it serves |
| `roleSlug` | at spawn, from `--role` (or a caller starting a named agent) | its role file |

`config.json` `v2.recordLineage` (default **on**; only an explicit `false` turns it off): with
it off, `parentSessionId` and `workstreamId` are **still written** but every reader treats them
as absent. Turning it off needs no migration, and turning it back on finds the lineage intact.
`sessionId` is identity, not lineage, so the setting never gates it.

```json
{ "v2": { "recordLineage": false } }
```

### Managers: session requests and spawn proposals

V2 step 10, behind `config.json` `v2.managers` (default **off**; Settings → Sidebar → Managers,
applied live). **Off, the app refuses every request below**, so every non-overseer spawn is refused
exactly as before.

A **manager** is a session whose role file declares `spawns:` — a list of role slugs, in the
Charter's inline form (`spawns: [worker-terminal, researcher]`), as a bare comma list, or as a YAML
block list. Absent or empty means it starts nothing. A parent `P` may spawn a child role `C` only
when all three hold (the Charter's §Delegation, `src/core/delegation.ts` `checkDelegation`):

1. `C` is listed in `P.spawns`;
2. `rung(C) <= rung(P)` on `observer < proposer < operator < autonomous`;
3. `C.spawns` is a subset of `P.spawns`.

Every refusal names the condition that failed. A role with no `active` file, or an `authority:`
that is not one of the four rungs, fails closed. **No check reads an environment variable**: the
role is the one on the app's own session record, and what it may do is its role file's, re-read
live (within 5 s of an edit).

#### The request directory

```
<coordDir>/sessions/<sessionId>/requests/<id>.json    in   (claimed into requests/.done/)
<coordDir>/sessions/<sessionId>/receipts/<id>.json    out
<coordDir>/delegation.jsonl                           one line per decision
```

Identity is **the directory a request was dropped in** — the connector channel's model, with a
session where a connector was; it is a local trust boundary, not authentication. Every request
carries `v`, `id` and `sentMs`, and every attempt gets a receipt:

```jsonc
{ "v": 1, "id": "…", "status": "accepted", "terminalName": "wt-main-9",
  "spawned": { "terminal": "wt-main-9", "branch": "wt/main-9", "sessionId": "…" }, "handledMs": 0 }
{ "v": 1, "id": "…", "status": "rejected", "handledMs": 0,
  "reason": "worker-terminal may not spawn worker-terminal — condition 1 of 3 (listed): worker-terminal has no spawns:, so it starts nothing" }
```

| verb | kind | what the app checks | exit codes |
| --- | --- | --- | --- |
| `spawn <repo> --task "…" [--role …]` | `spawn` | `checkDelegation(requester's role, child role)` in full; the child's parent is the requester | 0 · 2 refused or withdrawn · 3 unconfirmed |
| `tell <target> "<message>"` | `tell` | the requester is a manager, and the target is one of **its own descendants**, through accepted edges | 0 · 2 · 3 |
| `assign <terminal>` | `assign` | the requester is a manager; the target is unassigned or already on its team, is not the requester, an overseer or above it; and `checkDelegation(requester, target)` passes. Logged with who moved what | 0 · 2 · 3 |
| `propose-spawn --role <slug> --task "…" --why "…"` | `propose-spawn` | any session, whatever its rung. At most **3 open** per session; the same role + task, once declined, is refused with the decline's reason | 0 recorded · 2 · 3 |
| `proposal accept <id> [--repo <repo>] [--base <b>]` | `proposal-accept` | the requester is the proposal's addressee (its proposer's parent; any manager for one written while unassigned), it is open, its proposer is live — then **the same `spawn` check, in full** | 0 spawned · 2 · 3 |
| `proposal decline <id> --reason "…"` | `proposal-decline` | the addressee; a reason is required | 0 · 2 · 3 |
| `proposals [--all]` | — (reads the file) | nothing: read-only, no app needed | 0 |

`close` stays Kane's alone. Without `COS_SESSION_ID` these verbs are refused (exit 2) before
anything is written. Dragging a row in the sidebar never re-parents a session; `assign` is the only
way one moves.

#### Spawn proposals

**A proposal changes what the orchestrator is asked, never what it may do.** It is an inert line in
`<coordDir>/spawn-proposals.jsonl` (append-only, because `persist()` rewrites `config.json` from
memory); accepting one builds the very `spawn` the parent could have sent and checks it the same
way, so a proposal for a role the parent may not spawn is refused with the identical message.

```jsonl
{"v":1,"ev":"propose","ts":0,"id":"p-…","from":{"sessionId":"…","role":"worker-terminal","name":"wt-main-7"},"to":"<parent sessionId>","toName":"Lead","workstreamId":null,"role":"researcher","task":"…","why":"…"}
{"v":1,"ev":"accept","ts":0,"id":"p-…","by":"<sessionId>","byName":"Lead","spawned":"<child sessionId>"}
{"v":1,"ev":"decline","ts":0,"id":"p-…","by":"<sessionId>","byName":"Lead","reason":"…"}
{"v":1,"ev":"stale","ts":0,"id":"p-…","reason":"wt-main-7 ended"}
```

Only an open proposal can be decided, so the first decision wins. A proposer's open proposals go
stale when its session ends. Nothing escalates and nothing times out into a spawn: ignoring a
proposal is a legitimate outcome. Open proposals show as `◆N` on the addressee's sidebar row and
in its **Manager view** (open the ★ on a manager's row) — a full-window presentation of its team,
its `spawns:` and its proposals that grants nothing.

```json
{ "v2": { "managers": true } }
```

### Workstreams and tasks

V2 step 11. A **workstream** is the floor's unit of work, and it **carries its tasks inline** — one
unit, one place; a workstream with no tasks behaves exactly as one with them. It needs no repo, so
the six task measures (progress, task lead time, workstream age, blocked time, stale work, landed)
work in every workspace. The **CLI owns the store and the app only reads it**: `cos-coord` appends
to `<coordDir>/workstreams.jsonl`, which `persist()` never rewrites (D2), and a correction is a new
line, never an edit. It is written whatever `v2.projectPanel` says, so turning the panel on later
has history to show.

| verb | what it appends | refused (exit 2) when |
| --- | --- | --- |
| `workstream open "<title>" [--note <vault path>]` | `open`, id `ws-<n>` numbered from what is on disk | no title |
| `workstream assign <ws> [<sessionId> \| none]` | `assign` — default: the calling session | unknown id; already that owner |
| `workstream close <ws> [--dropped --reason "…"] [--commit <sha>] [--branch <b>]` | `close`, outcome `landed` (default) or `dropped` | not open; `--dropped` without a reason |
| `workstream reopen <ws> --reason "…"` | `reopen` — counted as **rework** | still open; no reason |
| `workstream task add <ws> "<title>" [--owner <id>] [--note <path>]` | a task `t<n>`, state `todo` | unknown workstream |
| `workstream task start\|block\|done\|drop <ws> <task> [--reason "…"]` | `doing` · `blocked` · `done` · `dropped`. Starting an unowned task makes the caller its owner | unknown task; already in that state |
| `workstream list [--all] [--json]` | nothing (read-only) | — |

Every write needs `COS_COORD_DIR` (any session the app opened has it) or `--dir <coordination dir>`,
and **is not fail-open**: exit 0 means the line is on disk, exit 2 means nothing was written and
stderr says why. The read, the id and the append happen under one guard, so two concurrent `open`s
never mint the same id. `by` is the caller's `COS_SESSION_ID` (else its terminal name).

```jsonl
{"v":1,"ev":"open","ts":0,"id":"ws-3","title":"Lease claims","by":"<sessionId>"}
{"v":1,"ev":"task","op":"add","ts":0,"id":"ws-3","task":"t1","title":"Write the store","by":"…"}
{"v":1,"ev":"task","op":"start","ts":0,"id":"ws-3","task":"t1","by":"…"}
{"v":1,"ev":"close","ts":0,"id":"ws-3","outcome":"landed","commit":"9b53b34","by":"…"}
{"v":1,"ev":"reopen","ts":0,"id":"ws-3","reason":"revert 4a1c2e0","by":"simon"}
```

The fold — and the `Workstream` / `Task` types — is `pty-sidecar/workstreams-core.cjs`, shared by
`cos-coord`, the app and `wcc-team metrics`, so all three read one answer.

### `attention.jsonl` — how long a session waited on you

The attention classifier (prompt / menu → `input`, errored → `help`, idle → `done`, else `none`)
runs every second in the mounted workspace. Since step 11 its result is also **recorded, as
transitions only**: a state that persists for an hour is one line, not 3600. Keyed by `sessionId`;
the overseer is included.

```jsonl
{"v":1,"ts":0,"ev":"boot"}
{"v":1,"ts":0,"sessionId":"…","name":"wt-main-9","from":null,"to":"input"}
{"v":1,"ts":0,"sessionId":"…","name":"wt-main-9","from":"input","to":"none"}
{"v":1,"ts":0,"sessionId":"…","name":"wt-main-9","from":"none","to":"unobserved","why":"unmounted"}
```

An interval ends at the session's next line. `unobserved` ends one without starting another: the
tile left the stage (`gone`), its workspace was switched away from (`unmounted` — only a mounted
grid is classified), or the app quit cleanly (`quit`). A `boot` line precedes a process's first
record, so an interval still open at the next boot — the app crashed — is reported as
**unknown-length**, never stretched across the hours the app was closed. Blocked time is the sum of
`input` + `help`. Written whatever `v2.projectPanel` says. Model: `src/core/attention-log.ts`.

### `wcc-team metrics` — the Project panel's numbers

```sh
wcc-team metrics [--json] [--workspace <id>] [--user-data <dir>]
```

Beside `wcc-worktrees` in `pty-sidecar/` (bundled from `src/cli/team-cli.ts` by `npm run build`).
It is how the app computes the Project panel: **as a child process, never on the UI thread** (D11)
— git never runs in the renderer's process — and the panel renders its JSON. Every figure is made by
`src/core/metrics.ts`, which the panel also calls for its live, file-backed sections, so there is
one implementation with two callers. Read-only: it writes nothing.

**It always prints its own cost to stderr** — wall time, the process's own lifetime, and every git
call with its exit code, duration and output size (NFR-2):

```
wcc-team: 10 workspaces, 7 repos · wall 336 ms (process 356 ms) · 14 git calls, 1911 ms summed
  git -C C:\dev\worktree-command-center for-each-ref "--format=…" refs/heads/main refs/heads/master refs/tags → 0 · 66 ms · 1 KB
  git -C C:\dev\worktree-command-center log --since=2026-10-09 "--format=…" main → 0 · 218 ms · 98 KB
```

Two git calls per **distinct** repo, however many workspaces share it, all repos at once. With
`--json`, stdout is `{ schema: 1, generatedAt, workspaces: ProjectReport[], timing }`.

Each `Metric` is `{ id, label, value, unit?, source, asOf, freshness, unavailable? }`. **`value` is
`null` exactly when `unavailable` holds the reason**; a `0` is always a measured zero. The nine are
always present, in this order:

| id | measures | source |
| --- | --- | --- |
| `lead-time` | median open → land of workstreams landed in 14 d; **until one has, a labelled proxy**: a branch's first commit (author date) → its first-parent merge | `workstreams.jsonl`, else `git log` |
| `open-work` | workstreams not landed or dropped (the panel lists them) | `workstreams.jsonl` |
| `landed` | merges, landed workstreams, done tasks and vault log entries, 7 d | git · `workstreams.jsonl` · `Personal/Code/Logs/<date> — <Project>.md` |
| `blocked-time` | hours in `input` + `help`, 7 d | `attention.jsonl` |
| `rework` | landed then reverted (`This reverts commit …`) or reopened, 14 d | git · `workstreams.jsonl` |
| `idle-alive` | sessions idle ≥ 20 min (a floor report older than 15 min is a reason) | `floor-report.json` |
| `isolation-cost` | worktrees created ÷ workstreams landed, 14 d | `isolation.jsonl` ÷ `workstreams.jsonl` |
| `highlights` | tags, and log bullets carrying `highlight::`, 14 d | `git for-each-ref refs/tags` · vault logs |
| `suggestions` | the newest Workflow Auditor notes naming the project in `project::` | `Personal/Code/Proposals/` |

Plus the three task measures that never touch git: `progress`, `task-lead-time`, `stale-work`
(a task `doing` unchanged for 3 days).

**Which repo a workspace is.** The tab's link; else the one repo tagged to it; else a repo whose
name is the workspace's (`Brain 2.0` ≡ `Brain_2.0`); else the repo most of its saved terminals work
in. Never the toolbar's selection, which is a habit rather than a declaration. No repo → the git
rows read *no repo* and the task rows still work. No role library → the vault rows read *vault not
configured*. Vault logs are matched by their filename's `— <Project>` part against the workspace and
repo names.

**The 📊 Project panel** renders this for the active workspace (`v2.projectPanel`, default off;
Settings → Sidebar → Project panel, applied live). It runs `wcc-team metrics --json --workspace <id>`
when it opens and at most every five minutes after, and recomputes open work, tasks and proposals
live from the files with the same functions. It **pins** beside the stage only while
`stageW − 400 ≥ minTileSize(m).w` — one 80-column terminal at the live font still fits — and
otherwise opens in the main pane; a pinned panel that stops fitting unpins. Its **Spawn proposals**
list has Accept / Decline, which act **for the proposal's addressee**: the decision is evaluated as
that session, so Accept runs the same `checkDelegation` against the addressee's role file as its own
`cos-coord proposal accept` would, spawns under it, and records `"by": "simon"`. A proposal written
while unassigned has no addressee, so the panel can only decline it. Profile:
[perf/step11-metrics-profile.md](perf/step11-metrics-profile.md).

```json
{ "v2": { "projectPanel": true } }
```

### Isolation modes

Where a new session in a **repo** target works is decided by `decideIsolation()`
(`src/core/isolation.ts`), a pure function of the spawn's intent, the role's rung and the setting.
Folder targets are not decided: they run in the folder, as always.

| mode | chip | where | granted at this step |
| --- | --- | --- | --- |
| `worktree` | `wt` | its own branch and worktree | always — every repo write |
| `shared-readonly` | `ro` | the repo's existing checkout; writes nothing | under `cheap-readonly`, and for a read-only rung always |
| `scratch` | `scr` | `<coordDir>/scratch/<sessionId>`, outside every target | under `cheap-readonly`, and for a read-only rung always |
| `shared-write` | `rw🔒` | the existing checkout, holding its exclusive write lease | under `cheapest-safe` only, never to a read-only rung |

`config.json` `isolation`: `"worktree-always"` (the default, and the rollback: every spawn gets
a worktree, exactly as before, unless its role is a read-only rung), `"cheap-readonly"`, or
`"cheapest-safe"`. Any other value reads as the default. It is read when the app starts.

```json
{ "isolation": "cheapest-safe" }
```

Under `cheapest-safe`, a repo write by `small-fix`, `config`, `investigate`, `doc` or `release`
work gets `shared-write` on the repo's own checkout, and the app takes the checkout's write lease
**before the session exists**. `feature` work always gets a worktree. A checkout someone else
holds makes it a worktree instead (FR-12); only a `release` and an explicit `--isolation
shared-write` are refused, naming the holder and the path. If another session takes the lease
between the decision and the take, the spawn is decided again and gets a worktree (or, for a
release, the refusal). A worktree session's claim is on its own path, so it never blocks
`shared-write` in the primary (Q9). **Rolling back** to `cheap-readonly` needs no cleanup: no new
lease is granted, and the existing ones expire on their own within their 10-minute TTL.

The intent: `--class` is one of `feature` (default), `small-fix`, `config`, `investigate`,
`doc`, `release`. `--writes` defaults from the class — `investigate` → `none`, `doc` →
`outside`, everything else `repo`. `--isolation` requests a mode; a request for `ro`/`scr` with
repo writes falls back to a worktree, it is never refused.

The rung ceiling comes from the role file's `authority:`, and applies under **every** policy,
`worktree-always` included — it is evaluated before the setting. An `observer` or `proposer` gets
`shared-readonly` or `scratch` whatever it asks for; an undeclared `--writes` reads as `none`
for it, and an explicit `--writes repo` is **refused**, naming the role and the checkout. Roles
carry no `isolation:` key. A refusal is a spawn receipt with `ok: false` whose reason names a
holder and a path.

A `ro`/`scr`/`rw` session is told its mode in its prompt (a Session facts line), and since step 9
the write hook **enforces the file-tool half** of it — see [Write claims](#write-claims-the-lease-and-the-write-hook),
including what it cannot see. Its record carries `folder: true`, so closing it never removes the
checkout or deletes a branch.

Every decision is appended to `<coordDir>/isolation.jsonl`, one JSON object per line: `ts`,
`repo`, `checkout`, `taskClass`, `writes`, `requested`, `policy`, `rungCeiling`, `role`,
`ok`, then `mode` or `holder` + `path`, `reason`, and once known `sessionId` and `cwd` (or
`failed` when the grant could not be carried out). It exists because the app's own `git worktree
add` does not pass through the coordination hook, so `board.md` undercounts worktree creation.


### Write claims: the lease and the write hook

V2 step 9. Two parts, one store.

**The store** is `<userData>/.coordination/_claims/` — **machine-wide**, beside the per-workspace
coordination directories, because a checkout is shared across tabs while `locks/` is per
workspace. One file per **checkout root**, `write-<sha1(checkout id)>.json`, created with the same
exclusive `wx` write every coordination lock uses (`pty-sidecar/claims-store.cjs`, built on
`coord-store.cjs` `acquireAt`). Never per path: two path-prefix claims are two files, and both
creates would succeed. The payload:

```jsonc
{ "v": 1, "resource": "write:c:/dev/app", "checkoutId": "c:/dev/app", "path": "C:\\dev\\app",
  "sessionId": "3f0c…e21a", "holderId": "3f0c…e21a", "holder": "fix-auth", "mode": "shared-write",
  "reason": "small-fix", "pid": 1234, "ts": 1763800000000, "ttlMs": 600000 }
```

A claim is a **lease**: the holder's PostToolUse hook re-stamps `ts` after every file-tool write.
A session that stops writing — dead, or just quiet — goes stale 10 minutes after its last write,
by the same rule as every lock (`lockStatus`), and a stale lease is free to take. Every unlink and
in-place rewrite of a lock or claim happens under a short `wx` guard that re-reads first, so a
stale takeover can never delete a lease someone has just taken fresh.

**The hook** is `coord-hook.cjs --write`, on `Edit|Write|MultiEdit|NotebookEdit` (PreToolUse; and
`--write --renew` on PostToolUse). For each write it reads every claim and decides
(`claims-core.cjs` `decideWrite`):

| the session | writing | answer |
| --- | --- | --- |
| any | inside a checkout another session holds a **live** lease on | **deny**, naming the holder and the path |
| `shared-write` | its checkout | take or renew its lease, then allow |
| `shared-readonly`, under `cheapest-safe`, write rung, not `feature` | its checkout | **escalate**: take the lease if free (allow), else deny naming the holder |
| `shared-readonly`, otherwise | its checkout | **deny** — stop, and be respawned in a worktree |
| `scratch` | the checkout it came from | **deny** |
| `shared-*` / `scratch` | a nested worktree (`.claude-worktrees/`) of its checkout | **deny** — another session's worktree |
| `shared-*` / `scratch` | outside its checkout | allow |
| `worktree` / no mode | its own checkout | allow |

Every denial says what to do: stop, do not work around it with a shell command, and ask to be
respawned in a worktree (or wait for the lease).

**Two failure policies, chosen in one place.** `coord-hook.cjs` `failurePolicyFor(COS_ISOLATION)`:
a `worktree` session (or one with no mode) is **fail-open** — a broken store allows its write, as
the Bash and Task hooks always have. A `shared-readonly`, `shared-write` or `scratch` session (or
an unrecognised mode) is **fail-closed**: an unreadable or missing store, a corrupt claim file, a
bad environment, a module that will not load or any thrown error **denies** the write. For those
sessions the hook is the only guard on a real checkout. The hook never creates `_claims/`; the
app does, at start.

**Release.** A session's leases are released when its tile closes — **only from a clean checkout**
(`git status --porcelain` empty). A dirty one keeps its lease, the app says so, and the lease then
expires by its TTL. `cos-coord lease release` gives a lease up early under the same rule, and exits
2 when it releases nothing. `cos-coord lease` (and `status`) lists every lease on the machine.

**The automatic git locks live here too (Q12).** The git hook's `push:<repo>` and
`worktree:<repo>` locks, taken around a `git push` / `git worktree add` and released after it, are
files `git-push-<sha1>.json` / `git-worktree-<sha1>.json` in `_claims/` — machine-wide, so two tabs
can no longer push one repo at the same moment. They are keyed on the **repository**: the git
common dir of the command's target (`git -C <dir>`, `cd <dir> &&`, else the cwd), which every
worktree of a repo shares. Before this they were named after the basename of the session's cwd, so
each worktree session had a lock of its own and two sessions pushing one repo never contended. Only
when git cannot name the repository (not a repo, an unexpanded `$d`) is the lock named the old
way, by the target folder's name. Owner: the session's `COS_SESSION_ID` (tile ids repeat across
tabs), or workspace + tile id without one; a holder taking its own lock again re-stamps it rather
than waiting on itself. TTL 10 minutes. Still **fail-open**, like every Bash-hook lock: a missing
store allows the command. `START`/`DONE` still go to the session's own `board.md`, and `cos-coord
status` and the Coordination panel list them in every tab. Explicit `cos-coord acquire` locks are
unchanged: per workspace, in `locks/`.

**Moves.** A live lease inside a repo refuses its Move and its relayout (`live-lease`), as a live
terminal does; an unreadable store refuses too. Stale leases are re-pointed with the rest of the
move (`remapPath`, the same rewrite the sessions file gets).

> [!warning] This is a cooperative guarantee, not a sandbox
> The hook sees **Claude's file tools** — Edit, Write, MultiEdit, NotebookEdit — which are nearly
> all of a session's edits. It **cannot** see a write that is not a file tool: a shell redirect
> (`echo x > file`), a formatter, an install, a build script, a `git checkout`. Nothing at the OS
> level stops a session from writing a shared checkout. Three mitigations, all partial: the
> session's role text forbids shell writes in the shared modes; a release is refused while the
> checkout is dirty, which is where a write the hook missed gets noticed; and the git hook still
> guards `push` and `worktree add`. Like the rest of the coordination layer, it holds between
> sessions that follow it. **Do not treat a shared checkout as protected from a session that
> ignores its instructions.**
