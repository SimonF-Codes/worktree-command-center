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
| [requests and receipts](#requests-and-receipts) | write, then read | `spawn` a new terminal, or `tell` a live one |
| [`wcc-client`](#the-client--wcc-client) | both | a CLI that wraps the two above |

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
{ "connectors": [{ "id": "brain-2-0", "label": "Brain 2.0" }] }
```

Both fields are required, and an entry missing either is ignored. This is a **local trust boundary
between the user's own apps, not authentication**. A request from an id that isn't registered is
still answered, with a rejected receipt, so a misconfigured caller finds out at once.

Registration is checked against the **directory** the request was dropped in
(`connectors/<id>/`), which is the identity the app trusts. The envelope's `connector` field must be
present but is not what's checked.

`config.json` is read at launch, so restart the app after adding a connector.

## What a connector may do

**`spawn` and `tell`, nothing else.** Not `watch`, `rename`, `close` or `personality`: those act on
the operator's own workspace (Kane's watchers, Kane's mode), not on requesting work, so they stay
the overseer's alone.

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
| `kind` | `"spawn" \| "tell"` | |

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
| `terminalName` | `string` | on `accepted`: the terminal a `spawn` created or a `tell` was delivered into |
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
| any other `kind` | `kind "<kind>" is not permitted for connectors — only "spawn" or "tell" is` |
| tell without `terminal`/`message` | `malformed tell request — "terminal" and "message" are required` |
| tell message over 4000 chars | `message is too long (<n> chars, max 4000) — trim it before sending` |
| spawn without `repo`/`task` | `malformed spawn request — "repo" and "task" are required` |
| directory id not in `config.json` | `connector "<id>" is not registered` |
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
connector never learns the floor's repo list or terminal roster from a reason string.

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
```

- **`floor`** prints one line per session from `state.json`, or the file itself with `--json`. A
  snapshot older than three intervals still prints, with a warning on stderr. A missing file
  exits 2.
- **`spawn`** and **`tell`** print the receipt's `terminalName` alone on stdout, so
  `name=$(wcc-client spawn …)` works.

### Exit codes

| code | meaning | safe to retry? |
| --- | --- | --- |
| `0` | accepted; the terminal name is on stdout | — |
| `2` | rejected (the app's `reason` on stderr), bad usage, or **withdrawn**: the app never picked the request up within the wait, so it was deleted and nothing will happen | yes, after fixing the cause |
| `3` | the app took the request but sent no receipt within the wait. **It may still happen** | no: check `floor` first. A blind retry of a `spawn` can open two terminals |

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
