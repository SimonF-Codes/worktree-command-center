---
status: stable
---

# Install as a Permanent App — design

**Date:** 2026-07-12
**Goal:** Run Worktree Command Center as a normally installed Windows app (Start Menu,
taskbar, own icon) instead of `npm run start` in a terminal, with a one-command refresh
that picks up new work — private overlay included.

## Problem

The app only runs via a dev-style launch (`npm run start` = build + `electron .`).
`npm run dist` exists but has never produced a working installer:

- `electron/main.ts` looks for the PTY sidecar at `process.resourcesPath/pty-sidecar`
  when packaged, but the electron-builder config has no `extraResources`, so nothing puts
  it there — packaged terminals could never spawn.
- No `files` list: the default packs everything (`src/`, `docs/`, a present `private/`)
  into the asar.
- No `directories.output`: electron-builder's default output (`dist/`) collides with the
  esbuild output directory.

Separately, the author's personal features live in the gitignored `private/` overlay, and
`scripts/check-no-private.mjs` deliberately blocks `npm run dist` while `private/` is
present. A personal install must include the overlay without weakening that public guard.

## Decision

**Approach A — NSIS silent reinstall.** Fix packaging, then add `npm run install-local`:
build (private overlay compiles in when present), produce the NSIS installer, close any
running copy, install silently. It never opens the app — the user launches it from the
Start Menu when they want it.

Rejected:
- **Portable dir build + hand-made shortcut** — faster refresh but hand-rolled Start
  Menu/uninstall integration; fragile for no real gain.
- **Auto-update via GitHub Releases (electron-updater)** — infra overkill for a
  single-user app, and public release artifacts could not include `private/`.

## 1. Packaging fixes (`package.json` `build` block)

- `extraResources: [{ "from": "pty-sidecar", "to": "pty-sidecar" }]` — sidecar scripts
  and the `cos-coord` shims land on real disk at `process.resourcesPath/pty-sidecar`,
  exactly where `main.ts` already looks in packaged mode.
- `files: ["dist/**", "index.html", "app.css", "styles.css", "assets/**"]` — the asar
  carries only runtime files. But an asar's `node_modules` only serve code running
  *inside* the asar — the PTY sidecar runs standalone under system `node.exe` from
  `resources/pty-sidecar/`, and Node resolves `require('node-pty')` up the sidecar
  script's own directory chain, never into `app.asar`. So a second `extraResources`
  entry copies `node_modules/node-pty` (stock N-API `prebuilds/win32-x64` binaries;
  `build/**`, `src/**`, `deps/**`, `third_party/**` excluded) to
  `resources/pty-sidecar/node_modules/node-pty`, putting it on that chain.
- `directories.output: "release"` — installer artifacts stop landing in `dist/`.
  `release/` is gitignored.
- **Per-user install stays the default** (`nsis.perMachine` remains unset/false). This is
  load-bearing, not just convention: the sidecar writes runtime files under its own
  directory (`pty-sidecar/contexts/` — see `terminal-tile.ts`), so
  `process.resourcesPath` must be user-writable. `%LOCALAPPDATA%\Programs\...` is;
  `Program Files` would not be.
- `nsis.runAfterFinish: false` — electron-builder's NSIS default is `true`, which
  launches the app the moment the installer finishes. Nothing may auto-open the app,
  including a plain double-clicked install run by hand outside `install-local`, so this
  is set unconditionally in `build.nsis`, not left to the script to suppress.
- `npmRebuild: false` — electron-builder's default rebuilds native deps for Electron's
  ABI, but no code in the Electron process loads a native module: `node-pty`'s only
  consumer is the sidecar, which runs under system `node.exe` and gets its own stock
  N-API copy via `extraResources`. The rebuild was pure waste — and node-gyp falling
  back to a source build made packaging fail on machines where that toolchain is cold.

## 2. `npm run install-local` (`scripts/install-local.mjs`)

Run from a checkout that has `private/` (the primary checkout) to include personal
features; from a clean clone it installs the public app with the stub — same script.

1. `npm run build` (tsc + esbuild; the existing esbuild hook compiles `private/index.ts`
   in when present).
2. `npx electron-builder --win --config.directories.output=release-private` — invoked
   directly, so `check-no-private.mjs` is not weakened: `npm run dist` keeps refusing to
   package while `private/` exists. Private-including installers go to a separate,
   gitignored `release-private/` directory so they can never be confused with (or
   published as) public artifacts.
3. `taskkill /IM "Worktree Command Center.exe" /F` — ignore "not running" failures.
4. Find the newest `*Setup*.exe` in `release-private/`, run it with `/S`
   (NSIS one-click installers support silent mode), wait for exit.
5. Do NOT launch the app — the user launches it from the Start Menu when they want it.
   The script only confirms the install landed: NSIS one-click installs per-user under
   `%LOCALAPPDATA%\Programs\<folder derived from productName>\`; the script globs
   `%LOCALAPPDATA%\Programs\*\Worktree Command Center.exe` (not a hardcoded folder
   name) and prints the found path.

## 3. Unchanged / constraints

- `npm run dist` behavior (public installer path, private guard) is untouched.
- The installed app still resolves `node.exe` and `claude` from PATH at runtime
  (`session-bridge.ts` spawns `node.exe`); both are dev-machine assumptions that hold
  here and get one README sentence. No bundled Node.
- No auto-start at login. No auto-update. Refresh is always explicit: rerun
  `npm run install-local`.
- Nothing ever opens the app window uninvited: the install script does not launch the
  app, and no build/verification step may start it. Only the user opens it.
- Same-version reinstall (0.1.0 over 0.1.0) is fine for NSIS; no version bump required
  per refresh.

## 4. README

Short "Install as an app" section: `npm run install-local`, what it does, the
Node + `claude` PATH requirement, and that `release/` + `release-private/` are build
artifacts.

## Testing

- No runtime code changes, so the vitest suite is unaffected; it must stay green.
- Manual end-to-end (the real acceptance test):
  1. `npm run install-local` from the primary checkout completes without errors — and
     does not open the app.
  2. Later, when the user chooses: launch from the Start Menu — window opens with the
     proper icon.
  3. Spawn a Claude terminal — proves sidecar + node-pty survived packaging.
  4. A private-overlay feature is visible (overlay really compiled in).
  5. Rerunning `install-local` while the app happens to be running closes it and
     installs cleanly (it stays closed until the user reopens it).
  6. `npm run dist` with `private/` present still refuses.

## Error handling

- Build or electron-builder failure → script exits non-zero with the underlying output;
  nothing is installed.
- `taskkill` when the app isn't running → ignored.
- No installer exe found in the output directory → clear error naming the directory.
- Installed exe not found under `%LOCALAPPDATA%\Programs\*` after install → warn with
  the searched location; the install itself already reported success.
