---
status: stable
---

# Install-Local (Permanent App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Worktree Command Center a normally installed Windows app with a one-command refresh (`npm run install-local`) that builds and silently reinstalls it — private overlay included when present, and without ever opening the app.

**Architecture:** Fix the existing electron-builder config so a packaged app actually works (the PTY sidecar must be copied to `process.resourcesPath/pty-sidecar`, where `electron/main.ts` already looks), then add a small Node script that chains build → package → silent NSIS install (no launch). No runtime code changes.

**Tech Stack:** electron-builder 25 (NSIS, already a devDependency), Node ESM scripts (`scripts/*.mjs`), PowerShell for verification.

**Spec:** `docs/superpowers/specs/2026-07-12-install-local-design.md`

## Global Constraints

- Windows-only feature: the script may hard-fail on non-Windows platforms.
- Per-user NSIS install: NEVER set `nsis.perMachine`. The sidecar writes `pty-sidecar/contexts/` under `process.resourcesPath` at runtime, so the install dir must stay user-writable (`%LOCALAPPDATA%\Programs`).
- Do NOT modify `npm run dist` or `scripts/check-no-private.mjs` — the public-installer guard stays exactly as is.
- Private-including artifacts must only ever land in the gitignored `release-private/`, never in `release/`.
- Script style: tabs for indentation, single quotes, `[install-local]`-prefixed log lines (match `scripts/check-no-private.mjs` / `scripts/fix-electron.mjs`).
- The installed app resolves `node.exe`, `git`, and `claude` from PATH at runtime — document, don't bundle.
- NEVER open the app window: no step may launch the app (packaged, unpacked, or dev), and the install script must not auto-launch it. Only the user opens the app, from the Start Menu, on their own schedule.

---

### Task 1: electron-builder packaging config

Make `npm run dist` / electron-builder produce a *working* packaged app: sidecar in resources, lean asar, output directory that doesn't collide with esbuild's `dist/`.

**Files:**
- Modify: `package.json` (the `build` block, lines 29–41)
- Modify: `.gitignore` (add `release-private/` after `release/`)

**Interfaces:**
- Consumes: `electron/main.ts` packaged-mode contract — `app.isPackaged ? path.join(process.resourcesPath, 'pty-sidecar') : …` (already in the code, unchanged).
- Produces: a `build` config that Task 2 invokes via `npx electron-builder --win --config.directories.output=release-private`. Default output for `npm run dist` becomes `release/`.

- [ ] **Step 1: Ensure this worktree has dependencies installed**

Run: `if (-not (Test-Path node_modules)) { npm install }`
Expected: no output (already installed) or a normal `npm install` finishing without errors (the `postinstall` fix-electron hook prints a `[fix-electron]` line — that's normal).

- [ ] **Step 2: Replace the `build` block in `package.json`**

Replace the current block:

```json
  "build": {
    "appId": "com.ronaldfridlyand.worktree-command-center",
    "productName": "Worktree Command Center",
    "win": {
      "icon": "assets/icon.ico",
      "target": "nsis"
    },
    "nsis": {
      "installerIcon": "assets/icon.ico",
      "uninstallerIcon": "assets/icon.ico",
      "shortcutName": "Worktree Command Center"
    }
  }
```

with:

```json
  "build": {
    "appId": "com.ronaldfridlyand.worktree-command-center",
    "productName": "Worktree Command Center",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**",
      "index.html",
      "app.css",
      "styles.css",
      "assets/**"
    ],
    "extraResources": [
      {
        "from": "pty-sidecar",
        "to": "pty-sidecar",
        "filter": ["**/*", "!contexts/**"]
      }
    ],
    "win": {
      "icon": "assets/icon.ico",
      "target": "nsis"
    },
    "nsis": {
      "installerIcon": "assets/icon.ico",
      "uninstallerIcon": "assets/icon.ico",
      "shortcutName": "Worktree Command Center"
    }
  }
```

Why each addition:
- `directories.output: "release"` — electron-builder's default output is `dist/`, which is esbuild's output dir; without this, `npm run dist` dumps installer artifacts on top of the compiled JS. Also makes the existing README line ("`npm run dist` … `(release/)`") true.
- `files` — replaces the default "pack everything" glob; the asar carries only what `index.html` references (`dist/renderer.js`, `dist/xterm.css`, `styles.css`, `app.css`), the compiled main/preload in `dist/`, and `assets/` (main.ts reads the window icon from `__dirname/../assets`, which resolves inside the asar). `package.json` and production `node_modules` (`node-pty`, xterm) are always included automatically; electron-builder auto-unpacks native modules like `node-pty` from the asar.
- `extraResources` — copies `pty-sidecar/` onto real disk at `<install>/resources/pty-sidecar`, which is exactly `process.resourcesPath/pty-sidecar` where `electron/main.ts:12-14` looks in packaged mode. Without this, packaged terminals can never spawn. The `!contexts/**` filter keeps runtime-generated session contexts from this dev checkout (gitignored `pty-sidecar/contexts/`) out of the installer.

- [ ] **Step 3: Add `release-private/` to `.gitignore`**

Change:

```
release/
```

to:

```
release/
release-private/
```

- [ ] **Step 4: Build the app and produce an unpacked package**

Run: `npm run build; if ($?) { npx electron-builder --win --dir }`

Expected: esbuild prints `esbuild: built main, preload, renderer`; electron-builder prints `building` lines and finishes without errors (first run may take a few minutes rebuilding `node-pty` for Electron's ABI). No NSIS installer is built with `--dir` — this is the fast config check.

Note: `--dir` output goes to `release/win-unpacked` (uses the new default output). Invoking electron-builder directly (not `npm run dist`) is fine even if a `private/` overlay were present — the guard only fences the public `dist` script.

- [ ] **Step 5: Verify the unpacked package layout**

Run:

```powershell
Test-Path 'release/win-unpacked/Worktree Command Center.exe'
Test-Path 'release/win-unpacked/resources/pty-sidecar/sidecar.cjs'
Test-Path 'release/win-unpacked/resources/pty-sidecar/cos-coord.cmd'
Test-Path 'release/win-unpacked/resources/pty-sidecar/contexts'
Test-Path 'release/win-unpacked/resources/app.asar'
Get-ChildItem -Recurse 'release/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty' -Filter '*.node' | Select-Object -First 1
```

Expected, in order: `True`, `True`, `True`, `False` (contexts excluded), `True`, and at least one `.node` file listed (native node-pty unpacked from the asar).

- [ ] **Step 6: Commit**

```powershell
git add package.json .gitignore
git commit -m @'
feat(build): packaged app actually works — sidecar in resources, lean asar, release/ output

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: `npm run install-local` script + docs

One command that builds (private overlay compiles in when present), packages the NSIS installer into `release-private/`, closes any running installed copy, and silently installs. It never launches the app.

**Files:**
- Create: `scripts/install-local.mjs`
- Modify: `package.json` (`scripts` block — add one entry after `"dist"`)
- Modify: `README.md` (build commands block + new "Install as an app" section)

**Interfaces:**
- Consumes: the Task 1 `build` config; `npm run build` (existing); NSIS one-click silent install convention (`Setup.exe /S`); installer artifact name `<productName> Setup <version>.exe`.
- Produces: `npm run install-local` — the user-facing refresh command. No exports; exit code 0 on success.

- [ ] **Step 1: Create `scripts/install-local.mjs`**

```js
// Build the app (private overlay compiled in when present), package a Windows
// installer, and silently (re)install it per-user. Never launches the app — the
// user opens it from the Start Menu when they want it.
//
// Deliberately does NOT go through `npm run dist`: that script guards against
// accidentally publishing private code in a public installer. This one targets THIS
// machine only — artifacts land in the gitignored release-private/, kept separate
// from public release/ installers.
import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

if (platform() !== 'win32') {
	console.error('[install-local] Windows only — this packages and installs an NSIS app.');
	process.exit(1);
}

const OUT = 'release-private';
const EXE = 'Worktree Command Center.exe';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

console.log(existsSync('private/index.ts')
	? '[install-local] private/ overlay present — compiling it in'
	: '[install-local] no private/ overlay — building the public app');

run('npm run build');
run(`npx electron-builder --win --config.directories.output=${OUT}`);

// Newest "<productName> Setup <version>.exe" in release-private/.
const setups = readdirSync(OUT)
	.filter((f) => /Setup .*\.exe$/i.test(f))
	.map((f) => ({ f, mtime: statSync(join(OUT, f)).mtimeMs }))
	.sort((a, b) => b.mtime - a.mtime);
if (!setups.length) {
	console.error(`[install-local] no "* Setup *.exe" found in ${OUT}/ — electron-builder output changed?`);
	process.exit(1);
}
const installer = join(OUT, setups[0].f);

// Close a running installed copy so the silent installer can replace its files.
// (Non-zero exit = not running; ignore. Dev sessions run as electron.exe, unaffected.)
spawnSync('taskkill', ['/IM', EXE, '/F'], { stdio: 'ignore' });

console.log(`[install-local] installing ${installer} silently…`);
const inst = spawnSync(installer, ['/S'], { stdio: 'inherit' });
if (inst.status !== 0) {
	console.error(`[install-local] installer exited with code ${inst.status}`);
	process.exit(1);
}

// Confirm the install landed — but do NOT launch the app; the user opens it from the
// Start Menu when they want it. NSIS one-click installs per-user under
// %LOCALAPPDATA%\Programs\<dir derived from productName>; glob instead of hardcoding.
const programs = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs');
let installed = null;
for (const d of readdirSync(programs)) {
	const p = join(programs, d, EXE);
	if (existsSync(p)) { installed = p; break; }
}
if (!installed) {
	console.log(`[install-local] warning: ${EXE} not found under ${programs}\\* — the installer reported success, so check the Start Menu.`);
	process.exit(0);
}
console.log(`[install-local] done — installed at ${installed} (launch it from the Start Menu)`);
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, change:

```json
    "dist": "node scripts/check-no-private.mjs && npm run build && electron-builder --win"
```

to:

```json
    "dist": "node scripts/check-no-private.mjs && npm run build && electron-builder --win",
    "install-local": "node scripts/install-local.mjs"
```

- [ ] **Step 3: Update README**

In the "Build from source" code block, after the `npm run dist` line, add:

```
npm run install-local   # install/refresh it as a Windows app (see below)
```

After the "Build from source" section (before "### Troubleshooting"), add:

```markdown
### Install as an app

`npm run install-local` builds the app, packages a Windows installer, and silently
(re)installs it per-user — Start Menu entry included, without ever opening the app
(launch it from the Start Menu when you want it). Rerun it any time to refresh the
installed copy with your latest code. If a `private/` overlay is present it is
compiled in; those installers go to the gitignored `release-private/` (separate from
public `release/` artifacts) and are meant to stay on your machine.

The installed app still resolves `node.exe`, `git`, and `claude` from PATH at runtime.
```

- [ ] **Step 4: Run it end-to-end**

Run: `npm run install-local`

Expected output, in order:
- `[install-local] no private/ overlay — building the public app` (this worktree has no `private/`)
- esbuild + electron-builder output ending in an NSIS installer build (this pass is slower than Task 1's `--dir` — NSIS compression)
- `[install-local] installing release-private\Worktree Command Center Setup 0.1.0.exe silently…`
- `[install-local] done — installed at C:\Users\<user>\AppData\Local\Programs\<dir>\Worktree Command Center.exe (launch it from the Start Menu)`

Exit code 0. **The app window must NOT open** — the script never launches it.

- [ ] **Step 5: Verify the install is real (without opening the app)**

Run:

```powershell
Get-Process 'Worktree Command Center' -ErrorAction SilentlyContinue
Test-Path "$env:APPDATA/Microsoft/Windows/Start Menu/Programs/Worktree Command Center.lnk"
Get-ChildItem "$env:LOCALAPPDATA/Programs" -Recurse -Depth 1 -Filter 'Worktree Command Center.exe' | Select-Object FullName
Get-ChildItem release-private -Filter '*Setup*.exe' | Select-Object Name
git status --porcelain release-private
```

Expected: NO process (nothing launched); `True` (Start Menu shortcut, named per `nsis.shortcutName`); the installed exe's full path; one `Worktree Command Center Setup 0.1.0.exe`; empty git status output (directory ignored).

- [ ] **Step 6: Commit**

```powershell
git add scripts/install-local.mjs package.json README.md
git commit -m @'
feat: npm run install-local — one-command install/refresh as a permanent Windows app

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Human acceptance + private-overlay install (post-merge)

The packaged mechanics are machine-verified in Tasks 1–2; what's left needs human eyes and the primary checkout (the `private/` overlay is gitignored, so it exists only there — not in this worktree).

**Files:** none (verification only).

**Interfaces:**
- Consumes: the installed app from Task 2; `npm run install-local` from the primary checkout after merge.
- Produces: sign-off on the spec's manual acceptance list.

- [ ] **Step 1: Human check on the installed (public/stub) app**

Whenever you choose, launch "Worktree Command Center" from the Start Menu: window has the proper icon in taskbar + title bar; add/select a repo and spawn a Claude terminal — the terminal starts and accepts input (proves sidecar + node-pty survived packaging).

- [ ] **Step 2: Merge this branch to `main`** (via the normal finishing flow — PR or merge, user's choice).

- [ ] **Step 3: Refresh the primary checkout and install the private build**

In `C:\Users\User\Dev\worktree-command-center` (primary checkout, where `private/` lives):

```powershell
git pull
npm run install-local
```

Expected: first log line is `[install-local] private/ overlay present — compiling it in`; installer lands in `release-private/`; the app does not open.

- [ ] **Step 4: Human check on the private build**

In the freshly installed app: a private-overlay feature (e.g. the journal tile) is present — proves the overlay compiled into the installed copy.

- [ ] **Step 5: Confirm the public guard is intact**

In the primary checkout: run `npm run dist`.
Expected: it REFUSES with `dist blocked: private/ overlay present …` (exit 1). This is the spec's "unchanged behavior" acceptance item.
