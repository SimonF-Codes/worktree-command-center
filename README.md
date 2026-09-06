# Worktree Command Center

Run many **Claude Code** sessions in parallel — each isolated in its own git
**worktree/branch**, tiled in one view — across whatever code folders you add.
Sessions coordinate through shared locks + a live board so they don't step on each
other, auto-save unfinished work, and can talk to each other (and you) in a group chat.

A standalone desktop app (Electron). Originally Windows-first; this fork adds macOS support.

> **Status:** early / in development.

## What it does

- **Add a folder** — point it at a single repo or a parent dir; it discovers the git repos inside.
- **Worktree terminals** — each terminal runs in its own `git worktree` on its own branch, tiled with a bubbling/centering layout; terminals that need you take the spotlight, and everything drops to an equal grid while they're all thinking. Pick the **model and effort** (up to ultracode) for new terminals from the toolbar dropdowns.
- **Kane, the overseer console** — a privileged Claude session docked beside the floor (Alt+K). He reads live snapshots of every terminal, and on request messages workers (`cos-coord tell`), watches for a terminal to finish (`watch`), spawns new worktree terminals (`spawn`, with `--model`/`--effort`/`--name`), and renames them (`rename`). Duplicate him (`🜲+`) for extra consoles, each its own session; drag his left edge to resize.
- **Focus discipline** — clicking or Alt+jumping to a terminal holds the spotlight there for 30 s (auto-centering can't yank you away mid-read); typing in Kane is never interrupted; Alt+←/→ steps back into the flow.
- **Coordination** — automatic locks on `git push` / `worktree add`, a live board of who's doing what, a registry of every worktree's unsaved work, and sibling-awareness injected into each session.
- **Park & reopen** — unfinished work is auto-saved as a recoverable commit when things close; one click brings it back. Minimized terminals keep their sessions alive and resurface from the Coordination panel or the ⚠ attention badge.
- **Workspaces** — independent floors of terminals (Alt+↑/↓ to cycle), each with its own repos and coordination dir.
- **Usage battery** — a topbar meter for your Claude limits: session, week, and Fable week, with a click-open detail popover, manual ⟳ (a fresh probe session every time), and a 60 s auto-refresh toggle.
- **Phone floor view** — a token-guarded HTTP view of the floor (e.g. over Tailscale) to check terminals and fire off spawns from your phone.
- **Journal tiles** — dictate/type a journal entry in a tile; optionally convert it into a Linear issue via your configured team.
- **Agent chat** — pull two or more terminals into a group chat you can message (hidden by default; see `terminals-grid.ts`).

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Alt+F1…F12 / letters | Jump to that terminal (badges show while Alt is held) |
| Alt+←/→ | Step the spotlight across tiles (incl. the equal-grid stop) |
| Alt+L | Lock/unlock the centered terminal in place |
| Alt+K | Open/focus Kane |
| Alt+↑/↓ | Switch workspace |

### External dispatch

A local, non-overseer app — a separate process on the same machine, not Kane and not spoofing
being Kane — can ask a workspace's floor to do work through the **connector channel**: a
directory pair per connector, under `coordDir` (`<userData>/.coordination/<workspaceId>`, the
`id` from `config.json`'s `workspaces` list):

```
<coordDir>/connectors/<connectorId>/requests/   you write requests here
<coordDir>/connectors/<connectorId>/receipts/   the app writes one receipt per request here
```

`<connectorId>` is a slug (`[a-z0-9-]`), e.g. `brain-2-0`. It must first be registered in
`config.json`'s `connectors` list (`[{ "id": "brain-2-0", "label": "Brain 2.0" }]`) — a local
trust boundary between the user's own apps, not authentication. A request from an id that isn't
registered gets a rejected receipt, not silence.

This is deliberately narrower than Kane's own channel (below): connectors get **`spawn` and
`tell`, and nothing else**. Not `watch` or `rename` or `personality` — those act on the
operator's own workspace (Kane's watchers, Kane's own mode), not on requesting work from a
terminal, so they stay the overseer's alone.

`tell` looks like it narrows the gap with Kane's `tell`, so the asymmetry is worth spelling out:
a connector may address **any** live terminal by its exact name — same as the user's ask ("submit
tasks to all the worktree command center tabs") — but only a terminal that already exists; it
cannot create, rename, or retarget one, an ambiguous or non-terminal (journal) name is rejected
rather than guessed at, the message is capped at 4000 characters (a paste-expanded message has
jammed a terminal's input before), and — the actual backstop against a connector spamming the
floor — every single attempt gets a receipt with a reason when it didn't land, so a connector
misbehaving is visible immediately rather than silently. There is no separate rate limit beyond
that; `spawn` has never had one either, and adding one only for `tell` would be a second,
inconsistent mechanism for the same risk the receipt trail already surfaces. A `tell` into a
terminal that's mid-task is still accepted and delivered — the message is typed into that
terminal exactly like Kane's own `tell`, which a running Claude Code session queues rather than
drops; "accepted" means "typed and submitted," not "acted on immediately."

Write a request atomically — a temp file in `requests/`, then `rename()` over the final name —
and give it a v1 envelope with an id you choose (the receipt refers back to it, so you can
correlate without parsing filenames):

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

A `spawn` request:

| field | type |
| --- | --- |
| `v` | `1` |
| `id` | `string` — your own unique id; the receipt is named after it |
| `connector` | `string` — your registered connector id |
| `sentMs` | `number` |
| `kind` | `"spawn"` |
| `repo` | `string` |
| `base` | `string \| null` |
| `task` | `string` |
| `model` | `string \| null` |
| `effort` | `string \| null` |
| `name` | `string \| null` |

A `tell` request — same envelope header (`v`/`id`/`connector`/`sentMs`), different body:

| field | type |
| --- | --- |
| `kind` | `"tell"` |
| `terminal` | `string` — exact live terminal name (case-insensitive if unambiguous) |
| `message` | `string` — max 4000 characters |

```json
{ "v": 1, "id": "...", "connector": "brain-2-0", "sentMs": 0, "kind": "tell",
  "terminal": "b2-drag", "message": "run the migration script and report back" }
```

**Discovering terminal names:** `<coordDir>/floor/INDEX.md` already lists every live terminal's
exact name (Brain 2.0 already reads this file for run reconciliation), refreshed every few
seconds — that's the roster a connector reads to pick a `terminal` value for `tell`. No second
mechanism was added for this; the file already existed, already lived under `coordDir`, and
already carried exactly the field (`name`) a `tell` needs to address.

For every request drained, the app writes `connectors/<connectorId>/receipts/<id>.json` — so
delivery is never inferred from a file just disappearing:

```json
{ "v": 1, "id": "...", "status": "accepted", "terminalName": "bx-a1--thing", "handledMs": 1788363509001 }
{ "v": 1, "id": "...", "status": "rejected", "reason": "unknown repo \"ghost\". Known: app, notes", "handledMs": 1788363509001 }
```

`status` is `"accepted"` (with `terminalName` — the terminal a `spawn` created, or the one a
`tell` was delivered into) or `"rejected"` (with a human-readable `reason` — always present, never
silent): the connector isn't registered, the envelope is malformed, `kind` isn't `spawn`/`tell`,
the repo is unknown, or — `tell` only — no such terminal, the name is ambiguous, the target is a
journal tile rather than a terminal, or the message is over the length cap. Receipts are the
connector's to clean up; the app prunes anything older than ~7 days on its own so the directory
can't grow forever if you stop reading them.

The canonical parser is `parseConnectorRequest`/`evaluateConnectorRequest` (and, for `tell`,
`resolveConnectorTellTarget`) in `src/terminals/connectors.ts` — its tests
(`tests/connectors.test.ts`) are the source of truth for exactly which fields are required and
which reject reasons exist.

**A workspace drains as soon as its grid exists**, same as Kane's channel below — every configured
workspace's grid is constructed at app launch, so a `spawn` into an unvisited workspace works
immediately.

#### Kane's own channel (internal, not an external integration point)

`god-outbox/` is where Kane's `cos-coord tell/watch/spawn/rename/personality` writes — it carries
the overseer's own privileged intent (typing into *any* terminal, renaming *anything*, toggling
`personality`), because the overseer console *is* the app's own trusted UI. It is **not** the
channel for an external app to use — that's what the connector channel above is for. Nothing
technically stops a local process from writing the same shapes into `god-outbox/` (the
`COS_ROLE=god` gate only guards the `cos-coord` *command*, not the file format), but doing so
means impersonating the overseer's full authority over the floor, not requesting work — treat that
as unsupported, not as a shortcut.

### Agent role files

The system prompt each session starts with — the worker terminal's, the folder terminal's, and
Kane's — can come from markdown files on disk instead of the strings compiled into the app. Point
`config.json` at a folder of them:

```json
{ "roleLibrary": { "path": "C:/Users/you/vault/_meta/agents" } }
```

Each file is frontmatter plus prose. Only three fields matter: `role:` is the slug the app looks
up (**not** the filename, so a role can be renamed for display without breaking anything),
`status:` must be `active`, and everything after the frontmatter becomes the prompt. The three
slugs the app asks for are `worker-terminal`, `folder-terminal` and `alpha` (the overseer).

```markdown
---
role: worker-terminal
status: active
---

## Mission

…
```

Runtime values are **not** templated into the prose — no `{{placeholders}}`. The app appends them
as a `## Session facts` block (repo, branch and worktree for a worker; folder and working
directory for a folder target; the floor's targets, coordination dir and overseer name for Kane),
so the file stays readable prose that a person edits.

Files are read **at session start**, so restart a terminal to pick up an edit; a running session
keeps the text it was given. Every failure — no key configured, missing folder, unreadable file, no
file with that slug, a role that isn't `active` — falls back to the compiled-in prompt, because a
session that starts with *no* instructions is far worse than one running a slightly stale default.
Each start logs one line naming the slug and the source:

```
[roles] worker-terminal — vault (Worker Terminal.md)
[roles] alpha — built-in (no roleLibrary configured)
```

Parsing lives in `src/terminals/role-library.ts` (pure, tested) with the file reads in
`src/terminals/role-loader.ts`.

## Build from source

```bash
npm install
npm start          # build + launch
npm test           # unit tests
npm run dist       # build a Windows installer (release/)
npm run dist:mac   # build a macOS dmg + zip, both x64 and arm64 (release/)
npm run install-local   # install/refresh it as a Windows app (see below)
```

Requires Node 20.19+ or 22.12+ (the test toolchain's native bindings need it) and Git on PATH.
Claude Code (`claude`) must be installed and on PATH.

### macOS code signing

`npm run dist:mac` builds unsigned by default, which is fine to run locally (no
Gatekeeper prompt for apps built directly on your own machine) but shows an
"unidentified developer" warning if the dmg is copied elsewhere. To sign with your
own local identity instead of a paid Apple Developer ID:

```bash
# one-time: create + trust a self-signed code-signing cert in your login keychain
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=Worktree Command Center Dev" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "basicConstraints=critical,CA:false"
openssl pkcs12 -export -out cert.p12 -inkey key.pem -in cert.pem -password pass:changeit
security import cert.p12 -k ~/Library/Keychains/login.keychain-db -P changeit -T /usr/bin/codesign -A
security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
rm key.pem cert.p12  # keep cert.pem if you want a record; the key is now in the keychain

# then build signed with it
CSC_NAME="Worktree Command Center Dev" npm run dist:mac
```

This only satisfies Gatekeeper on machines that trust your certificate — it's not a
substitute for a real Apple Developer ID (`developer.apple.com`, $99/year) plus
notarization, which is what's needed to distribute to people who haven't set up your
cert. `mac.identity` is intentionally left out of `package.json`'s `build` config so a
fresh clone still builds (falls back to unsigned) without this cert present.

### Install as an app

`npm run install-local` builds the app, packages a Windows installer, and silently
(re)installs it per-user — Start Menu entry included, without ever opening the app
(launch it from the Start Menu when you want it). Rerun it any time to refresh the
installed copy with your latest code. If a `private/` overlay is present it is
compiled in; those installers go to the gitignored `release-private/` (separate from
public `release/` artifacts) and are meant to stay on your machine.

The installed app still resolves `node.exe`, `git`, and `claude` from PATH at runtime.

### Troubleshooting

- **`Error: Electron failed to install correctly`** — on Windows + Node 24, Electron's
  installer downloads the runtime but its `extract-zip` step fails silently. A
  `postinstall` (`scripts/fix-electron.mjs`) re-extracts it with `Expand-Archive`
  automatically; if you still hit it, run `node scripts/fix-electron.mjs` (or
  `node node_modules/electron/install.js`) manually.

## Private extensions

The build looks for an optional, gitignored `private/` folder at the repo root. If
`private/index.ts` exists, it is compiled into the app and its exported
`registerPrivateFeatures(api)` runs once at startup; otherwise the no-op stub
`src/private-stub.ts` is used. This lets you keep personal features in a separate
private repo cloned at `private/`, with full TypeScript access to `src/`, without
forking. The hook's surface is defined in `src/private-api.ts` — including a per-workspace
session-env provider (e.g. to point sessions at another `CLAUDE_CONFIG_DIR` profile) and
hooks to restart the usage probe or every live session in chosen workspaces.

`npm run dist` refuses to package installers while `private/` is present (set
`WCC_ALLOW_PRIVATE_DIST=1` to include the overlay deliberately).

## License

MIT © Ronald Fridlyand
