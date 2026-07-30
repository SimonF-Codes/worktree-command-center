# Changelog

All notable changes to Worktree Command Center. Grouped by version; dates are when the work
landed on `main`.

## Unreleased

**The overseer now delegates code work instead of doing it himself**
- New DELEGATION section in the overseer's system prompt. Asked to write, change or fix code, he
  now defaults to putting a worker terminal on it via `cos-coord spawn` — one implementer per repo
  the task touches, briefed well enough to work unsupervised, then watched — rather than editing the
  files himself. He still implements inline when you explicitly ask, or for genuinely trivial
  one-line changes where spawning costs more than the edit.
- Read-only investigation is routed the other way: searching, reading, reviewing and summarizing
  code go to his own subagents, and the prompt pre-authorizes them so he doesn't stop to ask.
  Spawned terminals are reserved for work that actually changes code.
- Answering a question is explicitly not implementing — asking him what something does no longer
  risks a spawned terminal.
- Guardrails kept: this changes *how* he executes, not *whether* he acts. He still never starts work
  unprompted, and the prompt now states that delegation isn't abdication — he must say what he handed
  to whom and must never report a spawned terminal's or subagent's work as finished, or describe
  results he hasn't seen.

**The dev build is now labelled, so you can tell it apart from the installed app**
- Running from source (`npm start`) now shows a loud orange **DEV** badge beside the brand, and
  the window/taskbar title reads "Worktree Command Center — DEV". On Windows the dev build also
  gets its own AppUserModelID, so it's a separate taskbar entry instead of stacking with the
  installed app. The app *name* is deliberately unchanged — that's what picks the userData
  directory, so both builds keep sharing one profile (same repos, workspaces and sessions);
  they're just distinguishable now. A `run-dev.bat` launcher sits in the repo root for
  double-click starting.
- Caveat worth knowing: the two builds share that one profile, so running them **at the same
  time** makes them fight over the config file and port 7420. Run one at a time.

**CI/CD pipeline (GitHub Actions)**
- Dev/release tooling (not app behavior). `ci.yml` runs on every PR and push to `main`:
  typecheck, the full test suite, an esbuild bundle, a lockfile-drift check (via `npm ci`), a
  guard against committed build artifacts, and — on PRs — a check that `CHANGELOG.md` was
  updated (opt out with a `skip-changelog` label). `release.yml` fires on `v*` tags: it
  re-runs the checks, asserts the tag matches `package.json` and has a matching CHANGELOG
  section, then builds the Windows installer and publishes a GitHub Release. A PR template and
  `docs/ci-cd.md` document the flow. macOS packaging in CI is left as a follow-up (needs the
  signing cert as a secret).

**Per-tab attention markers + pop-up notifications**
- Every terminal tab now shows a distinct marker in its header the moment it needs you, so you
  can see the state of the whole floor at a glance without opening the topbar queue: ⏳ (amber)
  when a prompt or menu is waiting on input, 🆘 (red) when a session looks stuck or errored and
  wants help, and ✓ (green) when it has finished its turn and gone idle. The overseer button
  (Alpha/Kane) glows amber or red the same way when the overseer console itself is waiting on
  you or stuck.
- A colour-coded toast fires once whenever a tab (or the overseer) *transitions* into needing
  you — deduped so a state that persists is announced a single time, and seeded silently on
  restore so reopening a workspace never bursts a stack of notifications.

**Warns when the `claude` CLI isn't on PATH**
- Every terminal and the usage battery launch `claude` through the sidecar, so if it isn't
  installed or on PATH the app silently does nothing useful — blank terminals and a usage
  battery stuck on "unavailable". A red banner now appears under the top bar in that case,
  explaining the cause with the install command and a Recheck button, so you can fix PATH and
  confirm without relaunching. Detection mirrors how the sidecar actually resolves the command
  (via `cmd /c` + PATHEXT on Windows), so "not found" means a real spawn would fail.

**Chat tile: Up/Down recalls the messages you've sent**
- The "message the room…" box now behaves like a shell prompt — Arrow Up walks back through
  messages you've sent (Arrow Down walks forward, then restores whatever you were typing), so
  you can edit and resend without retyping. Only the room broadcast box has history; the
  per-agent reply cards are unchanged.

**Usage battery fixed for Claude Code 2.1.211's new /usage screen**
- The CLI now renders /usage inside a tabbed Settings view that is taller than the probe's
  24-row PTY, so the Fable and credits sections were clipped below the fold and never read.
  The probe now runs a 50-row PTY.
- The "Current week (Fable)" label paints in split cell runs (only "Fable)" lands next to its
  number in the stream), so the parser's full-label anchor never matched; it now anchors on
  the "Fable)" tail. The probe also waits for two identical consecutive reads before
  scraping, so a mid-paint screen can't be captured half-rendered.

**Create a new git repo without leaving the app**
- A 🆕 New repo button on the toolbar: choose (or create, via the picker's New Folder button) a
  location, name it, and the app `git init`s a fresh repo with a README + initial commit — so
  its worktrees have a base branch — then adds it to the workspace like any other repo.

**Repo self-optimization skills (`/self-review`, `/self-review-merge`)**
- Dev tooling under `.claude/skills` (not app behavior): `/self-review` runs bounded,
  test-gated optimization passes on a dedicated branch to spend spare end-of-period token
  budget tidying the code; `/self-review-merge` verifies that branch builds green against
  `main` and lands it.

## 0.1.0 — 2026-07-14

**Synced with the upstream project** — merged ~36 commits from the original repo, reconciling both
forks' overlapping work. Notable additions now available:
- **Model & effort per terminal** — pick the model and reasoning effort for new terminals from the
  toolbar; the overseer can spawn terminals with `--model`/`--effort`/`--name`.
- **Overseer upgrades** — duplicate overseer consoles (each its own session), drag-to-resize the
  panel, `Alt+K` to open it, a rename verb, and focus-hold discipline while you type.
- **Fable weekly** readout on the usage battery; a fresh probe session per refresh so the numbers
  actually update.
- **Session-env provider** threaded into every spawn (the groundwork for upcoming per-workspace
  SSH and role features), plus `npm run install-local` and a private-overlay hook.

**Overseer name is configurable**
- Set the overseer console's name in ⚙ Settings (default "Kane"). Applies immediately — the 🜲
  button and console header update on Save, no restart needed. (This replaced an earlier
  fork-only rename of the persona to "Able.")

**Packaging**
- The macOS codesign failure ("internal error in Code Signing subsystem" on `node-pty`'s dev
  build artifacts) is now root-fixed by skipping the native-module rebuild during packaging
  (`npmRebuild: false`), so the offending `node-gyp` output — including a symlink pointing outside
  the app bundle — is never created; a defensive bundle filter is kept as a backstop.
- Fixed the in-app 📋 Changelog showing empty in the packaged app: `CHANGELOG.md` wasn't in the
  build's file allowlist, so it never shipped. Now bundled.

## 0.0.0 — 2026-07-09 (pre-versioning)

_(The in-app 📋 Changelog button was added here; the persona rename to "Able" noted below was
later reverted to the now-configurable "Kane" — see 0.1.0.)_

**macOS support** (this was originally a Windows-only app)
- Packaging: mac `electron-builder` target (dmg + zip, x64 + arm64), fixed a build-output
  directory collision with esbuild, fixed a gap where the packaged app never actually included
  `node-pty` (terminals couldn't open at all) or its `spawn-helper` binary's executable bit.
- Process handling: POSIX process-group kill now actually works (was Windows-only before).
- New app icon, replacing an unrelated placeholder.
- Local self-signed code signing (no paid Apple Developer ID needed for personal use).
- Fixed Alt/Option+letter keyboard shortcuts, which macOS silently broke by composing most
  letters into accented characters when Option is held.

**Reliability**
- A terminal whose `claude` session exited used to go permanently dead — any key now revives it.
- Fixed the "no conversation found" `--continue` fallback never triggering (an ANSI-rendering
  bug), including on the very first resume attempt, not just on refresh.
- `Cmd/Ctrl+Shift+R` no longer force-reloads the whole app and orphans every live session — it
  wasn't a shortcut this app ever defined, just Electron's unblocked default.
- The usage battery now starts polling automatically and correctly dismisses first-run prompts
  (like Claude's Chrome-extension prompt) instead of getting permanently stuck.
- Worktrees no longer read as "dirty" from the app's own bookkeeping file
  (`.claude/settings.local.json`) — that's now excluded from `git status` via
  `.git/info/exclude`, for both new and existing worktrees.

**Features**
- **View Code** now actually detects whether opening your editor worked (it used to lie and
  claim success either way) and offers a picker — VS Code, Cursor, Sublime Text, Zed, Finder, or
  a custom command — with install-assistance if the one you pick isn't installed.
- **Journal → Convert to…** (renamed from "Convert to Linear", which was hardcoded to one
  specific team): now supports any number of configured destinations — task trackers (Linear,
  ClickUp, or any other MCP-based tracker) via the existing propose/review/create flow, and
  notes vaults (Obsidian) via a direct file write, no MCP involved.
- New ⚙ **Settings** panel to configure Convert-to destinations.
- Background-task board: tracks Task/Agent runs across terminals.
- The overseer console persona was renamed from Kane to Able, with a simpler symbol.
