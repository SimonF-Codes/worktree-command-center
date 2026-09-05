# Changelog

All notable changes to Worktree Command Center. Grouped by version; dates are when the work
landed on `main`.

## Unreleased

**A handoff to a worker terminal fails loud now, at every step, instead of quietly going nowhere**
- `cos-coord tell/watch/spawn/rename`, called as GOD but missing a required argument (an empty
  target, message, task, or `--to`), used to do nothing and exit 0 — the same silent-success shape
  as the missing-role case above, just one level down. They now exit 2 with a line on stderr
  naming what's missing, same as a role refusal.
- A tell/watch/rename whose *target name* doesn't match a live terminal (or a spawn naming an
  unknown repo) already wrote an error to `god-inbox/` — but nothing told the overseer to look
  there, and it wasn't in his own list of what he can see. He's now pinged directly, the same way
  a fired `watch` pings him, and `god-inbox/` is named in his system prompt.
- A dropped `god-outbox/` file that fails to parse (bad JSON, or missing a required field for its
  kind) used to be archived silently, indistinguishable from one that dispatched fine. It now
  leaves the same kind of note.

**A refused `cos-coord` command no longer reports success**
- `tell`, `watch`, `spawn`, `rename` and `personality` are GOD-only — called without
  `COS_ROLE=god`, they did nothing and exited 0, indistinguishable from having actually run. A
  caller checking the exit code (a shell `&&` chain, or an external process driving the CLI) had
  no way to tell a refusal from a success; found while a standalone dispatcher opened runs for
  terminals that were never actually spawned, and only discovered it much later when reconcile
  wrote them off as `unknown`. Refusal is now a failure: exit 2, with one line on stderr naming
  the missing role. The commands still do nothing else — only how the refusal is reported changed.

**External dispatch is now a documented, supported path**
- The `god-outbox/` file format Kane's `cos-coord tell/watch/spawn/rename/personality` writes to
  was an internal implementation detail with no stability promise, even though it already worked
  end-to-end for a local process writing to it directly. It's now documented in the README
  ("External dispatch") as a supported integration point, with the record shape for each `kind`
  — a shape change there is a breaking change going forward, not just a refactor.
- Its watcher also only armed once an overseer console had been opened in that workspace, so a
  command dropped before then just sat there unread — the workspace's grid didn't even exist yet
  if nobody had switched to that tab this launch. Every configured workspace's grid is now
  constructed (not mounted — its terminals stay unrestored until you actually switch to it) at
  app launch, and each one arms its outbox watcher from construction, independent of Kane. A
  `spawn` into an unvisited workspace now works immediately; `tell`/`watch`/`rename` still need a
  live terminal to target, so they resolve once that workspace has actually been switched to.

**A restored terminal that lost its conversation now actually tells you**
- 0.5.0 made the tile print a line when `--continue` found nothing to resume and it fell back to
  a fresh session. That line never survived: the replacement `claude` starts immediately after
  and repaints the whole screen over it, so the notice was gone before it could be read — the
  floor snapshot caught it mid-collision with the new banner. The symptom it was meant to
  explain (a blank welcome screen that looks exactly like a broken start) was unchanged.
- The notice now goes to a toast instead, which nothing in the session can repaint. Anything
  written into a tile belongs to the TUI running in it; this belongs outside.

**A duplicate overseer console comes back after a restart**
- A second 🜲 console — the `Kane 2` panel the toolbar’s 🜲+ button docks — was never written to
  the sessions file. `persist()` wrote exactly one `god` record and gated it on the primary, so
  the duplicate simply vanished on the next launch. Its conversation was still there:
  `.coordination/.god/<workspace>-2` held a real, multi-megabyte transcript that nothing in the
  UI could reach any more. Every duplicate now persists with its instance number, and each one
  reopens on the next launch with `--continue` against its own home directory.
- 🜲+ also started a duplicate fresh instead of resuming, and the instance counter lived only in
  memory — it reset to 1 every launch, so the next duplicate re-claimed `.god/<workspace>-2`, a
  directory already holding an unrelated conversation. The counter is now derived from the
  persisted records and the `.god` homes that actually exist on disk, so a new console can never
  land on a conversation that already belongs to another console.
- A record written before this change carries no instance number; that is the primary, and it
  still restores as the primary, so nothing currently open is disturbed. Closing a duplicate with
  its × drops its record and it stays closed; closing the workspace drops all of them. Nothing
  under `.god/` is ever deleted — the transcripts outlive the panels.

## 0.6.0 — 2026-09-02

**The model picker is current, and stays current**
- The list had gone stale: it named **Opus 4.8** as the top Opus long after Opus 5 shipped, and
  pinned `claude-haiku-4-5-20251001` — a dated snapshot rather than the canonical
  `claude-haiku-4-5`. Both are fixed, and Opus 5 is now offered.
- It no longer rots by construction. The everyday entries are now the CLI's **aliases** —
  `opus`, `sonnet`, `haiku`, `fable` — which the CLI resolves to the newest release in each
  family at spawn time, so they cannot fall behind a release. Exact versions are still offered
  below them for pinning a run to a known model, and those are the only rows that need touching
  when a new model ships.
- The list moved to its own module with a validator behind it, so the shapes that caused this —
  a dated snapshot id, a list with no aliases, a missing default row, duplicates — now fail the
  unit tests instead of going unnoticed.

**The release pipeline actually releases**
- Every tagged release since v0.2.0 failed at the same step, and no GitHub Release was ever
  produced. `npm run dist` ran `electron-builder --win` with no publish flag, and
  electron-builder's default policy (`onTagOrDraft`) meant a tag build tried to create the
  GitHub Release itself, then died with "GitHub Personal Access Token is not set". The installer
  had already built fine — only the publish step failed. `dist` now passes `--publish never`,
  leaving publishing to the workflow step that was always meant to do it.

## 0.5.0 — 2026-09-02

**Your tab settings stay put**
- The repo/branch/model/effort dropdowns were rebuilt from scratch every time a workspace
  mounted, so leaving a tab and coming back silently re-pointed ▶ Play at the first repo in the
  list and main/master — and an app restart did the same. Each tab now remembers its own
  selection in `config.json` and restores it on mount. A remembered branch that has since been
  deleted falls back to main/master rather than sticking.
- A repo can now belong to one workspace. `RepoConfig.group` had been in the type since the
  beginning with nothing reading it, so every tab offered every target; it is honoured now. A
  repo with no `group` still appears in every tab — which is every existing config — so nothing
  changes until you deliberately assign one (by hand in `config.json`; there is no UI yet).
- Closing a workspace now forgets its sessions bucket and its toolbar state instead of leaving
  them in the files forever.

**Settings stop losing each other**
- Config writes were fire-and-forget read-then-write pairs, so two overlapping saves — a theme
  change and a tab add, say — both read the old config and the slower one wrote its stale copy
  last, silently reverting the other. Writes are serialized now. This is the same race that had
  already been fixed for the sessions file after it cost a workspace every terminal record; the
  config file never got the same treatment.

**A blank restored terminal now tells you why**
- When a restored tile's `claude --continue` finds no conversation, it clears itself and starts
  a fresh session in place. It did that silently, so a terminal whose transcript was gone looked
  exactly like one that had started broken — right name, right branch, empty prompt, no
  explanation. It now says so on the first line. The behaviour is unchanged; it just stopped
  being invisible.

**The overseer sees the right repo**
- Terminals newer than the last worktree sweep (it runs every 30s) were reported to the overseer
  as repo `?`. Folder targets would have been `?` permanently, since the sweep skips them
  entirely. The floor roster now uses the target the tile actually carries.

## 0.4.0 — 2026-08-19

**Folders that aren't git repos can now be floor targets**
- "Add folder" on a directory with no `.git` (and no git subdirectories) used to add nothing at
  all and report it as a success — the picker closed, the count didn't move, and there was no
  hint why. Such a folder is now added as a **folder target** in its own right, so a notes vault
  or an asset directory can sit on the floor beside the git repos and get work done in it.
- Discovery order is unchanged: a folder that IS a repo still wins, and pointing the picker at a
  dev root still yields the git repos inside it rather than the parent.
- A folder target's terminal runs directly in the folder — no worktree, no branch. The branch
  picker shows an inert `(no branch — folder)`, `--base` is ignored, and the session's system
  prompt tells it the truth: no isolation, other terminals may be editing the same files, so take
  a `cos-coord` lock for batch edits.
- Closing a folder terminal leaves the folder alone. The `×` button deletes a worktree and its
  branch, and teardown auto-commits dirty worktrees — both would have targeted whatever repo
  happened to contain the folder, so both now skip folder targets.

**Toasts tell you what actually happened**
- Only 1 of 36 toast call sites passed a variant, so "Couldn't create repo" and "Saved" rendered
  as the same grey box. Every call site now carries a severity — success, error, warn or info —
  with a coloured rail, and errors additionally get a faint red wash so a failure reads as one at
  a glance.
- Toasts were all positioned at the same fixed corner, so two fired close together rendered
  exactly on top of each other and only the last was readable. They now stack: at most three are
  shown, the rest wait behind a "+N more" pill, and a queued error is promoted ahead of queued
  chatter rather than waiting its turn.
- Repeated identical messages collapse into one toast with a ×N counter instead of filling all
  three slots.
- Lifetime scales with severity (info 3s → error 8s). Toasts are semi-transparent over a backdrop
  blur so they never fully hide the terminal beneath; hovering makes one opaque and holds its
  countdown, and clicking dismisses it.
- Vague messages were reworded, not just recoloured: `Worktree failed: <msg>` now names the repo,
  `Folder unreachable` says what to check, and `Format failed` says the journal is unchanged.

## 0.3.0 — 2026-08-06

**Synced with the upstream project** — merged 11 commits from the original repo
(RonaldF444/worktree-command-center), covering its 2026-07-08..07-30 development window. Both
forks had moved on independently since the 0.1.0 sync; everything below is upstream work now
available here, reconciled with ours.

**The floor got substantially faster under load**
- Hidden and workspace-detached tiles stop parsing PTY output in real time. Only the CENTERED
  tile is live; visible satellites batch on a 300ms cadence and hidden ones on 2s, with a flood
  drop + resize-nudge re-emit so a suspended tile still shows the truth when you come back to
  it. Several sessions streaming at once used to starve the renderer's event loop in sub-250ms
  increments — measured as continuous heartbeat stalls.
- Terminals now render through WebGL, cursor blink is off, and short deterministic commands
  (git and friends) run on a dedicated worker thread. `spawn()`'s CreateProcess call blocks
  whichever thread issues it (~50–100ms each with antivirus in the way): on the renderer that
  stuttered painting, on main it delayed every input event. The worker absorbs it.
- Chromium's native window-occlusion detection is disabled — it misfires on virtual display
  adapters and throttled the renderer to ~1Hz while it thought the window was hidden.
- The coordination-dir scan is rate-limited, and the renderer samples its own heap/DOM plus a
  longtask/gap stall detector into `perf-log.jsonl`.

**Ready queue is now first-finished-first-served**
- Terminals that finish take the center in FIFO order and HOLD it, instead of the newest
  finisher barging in. A 4s hands-off grace stops a steal while you're still reading; clicking
  away demotes the held tile; cycling to the overview clears the queue and holds it there. Idle
  re-fires can no longer resurrect the queue or steal the center.

**Shell themes: Olympus, Hades, Iris**
- A theme picker in the top bar, applied instantly and persisted. Each theme carries its own
  terminal palette — light wells get heavier faces and a 3:1 contrast floor — and every live
  terminal in every workspace re-tints on the spot. Tile and panel surfaces match their wells.

**Alt+J opens a journal entry, F11 goes fullscreen**
- Alt+J spawns a new journal tile from anywhere (auto-repeat ignored, so holding the keys can't
  mass-create tiles). F11 toggles native fullscreen no matter which tile has focus, and ignores
  modifier combos so Alt+F11 still jumps to the 11th tile's badge. Ctrl+1..9 are forwarded to
  the renderer as shell shortcuts. All three are intercepted in the main process, so a focused
  terminal (or an embedded webview) can't swallow them.

**Kane survives restarts, and can build what the floor proves it needs**
- The overseer console now resumes its conversation across app restarts (`--continue`; `/clear`
  starts fresh) instead of coming back blank.
- New opt-in charter: when `config.json` names the app's own source repo under `god.sourceRepo`,
  Kane's prompt gains one scoped exception to acting-only-on-request — he may build concrete,
  recurring-need integrations in a worktree of that source (tests green, merged locally, never
  pushed, never reinstalled) or standalone tools in `god.toolsDir`, announcing each via
  `cos-coord note`. His scoped settings pre-allow Edit/Write/git/npm/node so the loop doesn't
  stall on a permission prompt per edit. Unconfigured, nothing changes.

**Copy/paste fixed in the packaged app**
- Clipboard now goes through the main process over IPC. Renderer-side `electron.clipboard` is
  deprecated (removal planned for Electron 40) and `navigator.clipboard` fails silently without
  focus/permission — which is exactly what happened in the installed build. One shared utility
  replaces the duplicated helpers in the terminal tile and the overseer console.

**The spotlight no longer bounces around on its own**
- Claude Code turns on focus reporting (DECSET 1004), so xterm answered every focus and blur —
  including the ones the grid itself caused by centering a tile — on the same channel as typing.
  That read as "someone is working here", dropped the tile from the idle set, and the 1Hz
  auto-center walked the spotlight from tile to tile with nobody at the keyboard. Focus reports,
  mouse reports and DSR/DA/OSC/DCS replies are now separated from real keystrokes. Arrows,
  F-keys, a bare Escape, backspace and bracketed paste still count as input, and every byte is
  still forwarded to the PTY — Claude keeps receiving the reports it asked for.

**Session records are no longer silently wiped**
- Two stacked bugs could erase a whole workspace's session history. Persists now flow through a
  single serialized chain with the state snapshot taken at write time, so a fire-and-forget
  write mid-restore can't rewrite the group from a stale empty snapshot. And a record whose
  worktree path fails `fs.access` is RETAINED and retried next launch instead of being pruned —
  one launch with a moved repo or an unmounted drive used to delete it permanently. Each record
  also restores inside its own try/catch, so one bad record can't abort the loop.

**Our session settings no longer live inside your worktrees**
- The hooks/permissions file we generate for each terminal is now written once beside the
  sidecar and passed to each session with `claude --settings`, instead of being written into
  every worktree as `.claude/settings.local.json`. A repo may legitimately track its own copy of
  that file; writing ours on top clobbered the repo's config, left every worktree permanently
  dirty with that one file, and let auto-parking commit its deletion onto the branch. Worktrees
  created by earlier builds still get their leftover copy hidden via `.git/info/exclude`.

**Fork reconciliation notes** (where the two forks disagreed)
- Our generalized journal "Convert to…" destination picker is kept; upstream's hardcoded
  Linear-only converter is not reinstated.
- Our narrower node-pty packaging filter is kept — it's what fixed the macOS codesign failure,
  and it produces a working Windows payload.
- Alt+K, Alt+L and the new Alt+J all match on the physical key (`e.code`) rather than `e.key`,
  because Option composes accented characters on macOS.
- The overseer prompt now takes both our configurable overseer name and upstream's
  self-improvement block, and the name is used inside that block too.
- Our Cmd/Ctrl+R reload block, `claude`-not-on-PATH banner, DEV badge, per-tab attention markers
  and revive-a-dead-session-on-keypress all survive the merge; the keypress revival is now gated
  on real user input so a focus report can't revive a session by itself.
- Upstream's temporary loopback `remote-debugging-port` (opened for its 2026-07-22 lag hunt) is
  deliberately NOT carried over — a packaged build shouldn't ship a live DevTools listener.

## 0.2.0 — 2026-08-05

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
