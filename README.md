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

A local, non-overseer process can ask the app to act on a workspace's floor without going
through Kane at all: drop a JSON file into `<coordDir>/god-outbox/`, where `coordDir` is
`<userData>/.coordination/<workspaceId>` (the `id` from `config.json`'s `workspaces` list). This
is the exact channel `cos-coord tell/watch/spawn/rename/personality` writes to — it is a
documented, supported integration point, not an implementation detail, and a change to the shapes
below is a breaking change.

Write atomically — a temp file in the same directory, then `rename()` over the final name — so the
watcher never reads a half-written file:

```js
const fs = require('fs'), path = require('path');
const ts = Date.now(), rand = Math.random().toString(36).slice(2, 8);
const outbox = path.join(coordDir, 'god-outbox');
fs.mkdirSync(outbox, { recursive: true });
const final = path.join(outbox, `${ts}-${rand}.json`);
const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
fs.writeFileSync(tmp, JSON.stringify({ ts, kind: 'spawn', repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null }));
fs.renameSync(tmp, final);
```

Record shapes (`kind` selects the fields; an untagged `{target, message}` is read as `tell` for
back-compat):

| kind | fields |
| --- | --- |
| `tell` | `target: string`, `message: string` |
| `watch` | `target: string`, `note: string` |
| `spawn` | `repo: string`, `base: string \| null`, `task: string`, `model: string \| null`, `effort: string \| null`, `name: string \| null` |
| `rename` | `target: string`, `name: string` |
| `personality` | *(no fields)* |

The canonical parser is `parseOutboxMessage` in `src/terminals/god.ts` — its tests
(`tests/god.test.ts`) are the source of truth for exactly which fields are required.

Caveats:
- **The gate on `cos-coord`'s CLI (`COS_ROLE=god`) does not apply here** — it guards who may run
  the *command*, not the file format. Writing directly to `god-outbox/` is the supported way for a
  process that isn't Kane (and isn't spoofing being Kane) to reach the same channel.
- **A workspace drains as soon as its grid exists**, which now happens at app launch for every
  configured workspace, not just the one you're looking at or one where Kane has been opened —
  see the Unreleased changelog entry. `spawn` works immediately even in a workspace nobody has
  switched to yet this launch, since it doesn't need an existing session. `tell`/`watch`/`rename`
  target a *live* terminal by name, so they only resolve once that workspace has actually been
  mounted (switched to) this launch and the terminal exists; until then they fail with an error
  written to `<coordDir>/god-inbox/` rather than silently doing nothing.

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
