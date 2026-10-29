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
