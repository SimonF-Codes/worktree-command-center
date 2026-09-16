# Changelog

All notable changes to Worktree Command Center. Grouped by version; dates are when the work
landed on `main`.

## Unreleased

**🪟 The stage lays tiles out by the SHAPE of the space, not just how many there are**
- Both layout functions picked their shape from the tile count alone — `ceil(sqrt(n))`, with the
  stage width and height used only to size cells inside a shape already decided. Four terminals
  were a 2x2 grid on every screen there is: on a portrait monitor that halved an already-narrow
  width, on an ultrawide it left the horizontal space unused.
- The shape now comes from a search over every (cols, rows) that can hold the tiles, picking the
  one that maximises the smallest resulting cell **measured in character cells**. Portrait and
  ultrawide stop being special cases — the same rule produces a stacked column on a vertical
  monitor, full-height columns on an ultrawide, and 2x2 on a square screen.
- The minimum — roughly **80 columns by 20 rows**, below which the Claude TUI wraps badly and the
  input box falls off the bottom — is read from the LIVE terminal metrics, not hardcoded in
  pixels. Cell size moves with the font size and the display DPI, so a pixel floor is correct on
  one screen and wrong on the next, which is the whole bug. The old `90px`/`60px` floors are gone.
- **A layout preference per workspace**: Auto (default) · Grid · Columns · Rows · Focus. It rides
  on the same per-tab state as the repo/branch/model/effort dropdowns, so a tab opened on a
  vertical monitor keeps its own choice across restarts.
- **Auto follows the window as you resize it**, reading the stage aspect: narrow stacks into rows,
  ultrawide splits into full-height columns, everything between gets the best-fit grid. Switching
  bands needs the aspect to cross the boundary by ~10% — without that margin, dragging a window
  edge flips the layout back and forth for the whole drag.
- **The centred layout puts its satellites where the stage has room**: top/bottom bands on a
  narrow stage, left/right columns on a wide one. They used to round-robin into left, right, top,
  bottom by index, so on a portrait monitor the first two satellites took 40% of the scarce
  dimension. Their thickness is now capped so the centre keeps a usable terminal.
- **When the tiles genuinely cannot fit, the stage scrolls** rather than shrinking them into
  unreadable slivers, and it prefers to scroll downwards past full-width tiles over sideways past
  half-width ones. Nothing is auto-hidden — a tile never vanishes without being asked.

**🧠 Memory — what every session costs, and what is running that no session owns**
- A panel, next to Changelog, listing every live session ACROSS EVERY WORKSPACE with its repo and
  branch, the RAM of its sidecar and everything under it, and how long it has been idle, biggest
  first. The sessions you forget are by definition in tabs you are not looking at, so a panel
  scoped to the visible tab would miss exactly the ones being hunted.
- Attribution comes from the **process tree, not the tile list**. Each tile's `SessionBridge` now
  exposes its sidecar pid, and a session's memory is that pid's subtree rolled up — exact
  ownership, no command-line string matching. One `Win32_Process` snapshot per poll returns every
  process, its parent and its working set in a single call; a tracker that spawned a process per
  session to count processes would be the bug it exists to report.
- **Anything under the app that no session claims gets its own "Unattributed" row**, at the top,
  in red. That row is the feature, not an edge case: replaying the 2026-09-16 snapshot with the
  five sessions the floor was showing puts **13.6 GB across 237 processes** in it. A tracker built
  by summing tiles would have agreed with the floor and reported five healthy terminals.
- Polls every 20s and ONLY while the panel is open. The snapshot subtracts the process it spawns
  to take the snapshot — otherwise ~85 MB of PowerShell lands in "Unattributed" every poll, the
  measuring tool reporting itself as a leak and the one row that must be trusted crying wolf.
  The usage battery's own probe is a named row for the same reason.
- **Closing never happens on its own** — which sessions matter is a judgment the app does not
  have. Close one, or close every session idle longer than a chosen threshold; the bulk confirm
  names them rather than just counting them, and never includes a session that is working.
- Closing from here is deliberately NOT the tile's ×, which deletes the worktree and branch.
  Transcripts in `~/.claude/projects` are keyed by worktree PATH, so deleting the worktree is
  exactly what would make one unresumable. Uncommitted work is parked as the usual `wip:` commit,
  the process is killed, and the worktree and branch stay — Reopen brings the whole thing back.
  The panel says so, because that is what makes the button easy to press.
- Closing a BUSY session warns that it loses the turn in progress; closing an idle one says
  plainly that nothing is lost. That distinction is the only real risk in the feature.

**The usage battery leaked a `claude` session every five minutes — about 3 GB an hour**
- Measured on the live machine 2026-09-16: 81 `claude` processes holding 19.5 GB and 80 node
  sidecars holding 3.5 GB, while the floor showed five terminals. 31 of those sidecars sat in the
  usage-probe's scratch directory, spaced exactly 5.0 minutes apart from 05:50 to 08:20 — one per
  `AUTO_MS` tick of the usage bar, going back to the moment the app started.
- The cause was a callback that outlived the session it belonged to. `UsageProbe` keeps the
  current session in `this.bridge`, and each session's `exit` handler cleared that field without
  first checking the session was still the current one. When a refresh's first pass came back
  empty, the probe killed it and immediately started a replacement; the dead session's `exit`
  landed a few hundred ms later and nulled `this.bridge` out from under the *live* one.
  `refreshOnce()` then threw `session unavailable` before reaching its `dispose()`, and the
  running sidecar's pid was gone from the program for good. Reproduced deterministically:
  2 sessions spawned, 1 leaked. After the fix, 2 spawned, 0 leaked.
- The handlers are now addressed to their own bridge, cleanup moved into a `try/finally` so no
  throw can skip it, and the deferred Enter/Escape writes target the session that asked for them
  instead of whatever session happens to be current.
- `SessionBridge.kill()` was fire-and-forget: it spawned `taskkill`, read neither exit code nor
  stderr, and set `this.proc = null` regardless — so a kill that failed was both silent and
  unrecoverable, because the pid was forgotten in the same breath. Kills are now verified
  (`kill-tree.ts`): the exit code is read, `128`/"not found" counts as confirmed, a failure is
  retried once and then reported through `onKillFailure`, and **the pid is kept until the death is
  confirmed**. Unconfirmed pids are remembered for a later sweep. That is not what caused this
  leak, but it is why nobody saw it for 31 refreshes.
- Strays are reaped at startup (`stray-reaper.ts`). A probe session left by a previous run holds
  ~250 MB and nothing in the new process knows its pid, so it survives until the machine reboots.
  Only the probe's own dedicated directory is ever swept: a sidecar in a real worktree may belong
  to a second running instance (dev and installed builds share one profile) and is left alone.
  Running the reaper against the machine freed 6.1 GB across 29 processes, with none refused.
- The 5-minute cadence and what the bar scrapes are unchanged. The cadence was never the problem.

**A notification never types into a line you are still writing**
- A watch firing while you were mid-sentence in Kane's console did not overwrite your draft — it
  MERGED with it and pressed Enter, submitting the mixture as if you had written it. `notify()`
  wrote the notice into the PTY as keystrokes and pressed Enter 250ms later, without ever looking
  at what was already in the input box. `TerminalTile.sendLine` (chat broadcasts, relays, an
  overseer-spawned terminal's initial task) had the identical shape and the identical bug.
- Both now go through one shared gate (`notice-gate.ts`), which tracks the input box from the
  keystrokes the app already sees on their way to the PTY — no screen scraping of the TUI's prompt
  line, which changes too often to depend on. An empty box behaves exactly as before, including
  the 250/900ms Enter pair, which is unchanged and still load-bearing. A non-empty box queues, and
  the queue is released on the transition back to empty: your Enter, Ctrl+U, Esc, or backspacing
  the line away.
- Nothing is ever dropped. Exact duplicates coalesce and the entry count is capped, but overflow
  merges rather than discarding, and a release delivers everything pending as one message — a
  watch notice is the only thing that tells the overseer a worker finished.
- While anything is held, the session's header says `⏳ N waiting`, with the way out in its
  tooltip; clicking it delivers immediately, draft and all, for when you want it anyway. A queued
  notice that said nothing would read exactly like no notice at all.
- The tracker is a heuristic, so a session's `.cos-ready` marker resyncs it (Kane's console now
  gets a `Stop` hook to produce one). There is deliberately no timer that delivers anyway after N
  seconds — that is the original bug with a delay. The resync also waits for a moment's quiet at
  the keyboard first: a turn ending does not prove the box is empty, because you can type while
  Claude works.
- `cos-coord tell` doesn't queue — delivery there is verified, and a queued message hasn't been
  delivered. It now refuses while someone is typing in the target and retries on its existing 5s
  cadence. This also stops a retry's `Ctrl+U` (meant for a stale unsubmitted retry) from wiping a
  real draft, and an exhausted retry window now says so specifically instead of blaming a compact.

**The connector channel's `tell` had the same swallowing bug as `cos-coord tell` — closed the same way**
- `handleConnectorRequest` typed the message in and wrote an `accepted` receipt immediately,
  unconditionally — the same fire-and-hope `sendLine` call the CLI `tell` fix above replaced, just
  behind a second door. This one is the door Brain 2.0's butler actually uses, and its documented
  contract ("accepted" = "typed and submitted, not acted on") was false until now: four messages
  were lost to `/compact` in one session through paths shaped exactly like this one, each reported
  as delivered.
- A connector `tell` now routes through the same seam Kane's own `tell` uses
  (`deliverTellQueued`/`TerminalTile.deliverLine`) rather than a second mechanism — the two even
  queue against the same terminal in arrival order. The receipt is written only once delivery is
  confirmed or the ~40s retry window gives up: `accepted` only when the text actually landed,
  `rejected` with the real reason otherwise (an unresolved target, the retry window running out, the
  terminal closing mid-delivery).
- No wire-shape change: Brain 2.0's `parseReceipt` already reads an absent receipt file as
  "unanswered", so the window before delivery resolves (now up to ~40s instead of instant) needs no
  new status value — it's just what "unanswered" already meant.
- `spawn`'s `accepted` receipt is unaffected by this pass — it fires once the terminal itself is
  created, which is true the moment it's written. Its *initial task* is a separate, later delivery
  (queued, sent on first ready) with the same unverified `sendLine` shape, but spawning a terminal
  first gates on an explicit ready signal rather than typing into a session of unknown state — a
  narrower window than `tell`'s, and not the one this pass targeted.

**`cos-coord tell` no longer reports success for a message that was never delivered**
- `sendLine` typed the text into the target's PTY, fired two timed Enters, and returned — it never
  checked anything actually landed. Observed losing three messages in one session: each target had
  just hit `/compact`, and the message vanished into the compacting TUI while `tell` still reported
  success and the file drop still exited 0. The fix so far (an extra timed Enter, twice before this)
  was fire-and-hope for a different class of the same bug; this one gets a real feedback path
  instead of a third guess.
- Delivery is now VERIFIED: after sending, the tile checks its own recent output for the sent text
  before believing it landed (`TerminalTile.deliverLine`, `looksDelivered` in `prompt-detect.ts`).
  A message that doesn't land is held and retried (clearing any stray unsubmitted text first) every
  5s for up to 40s — long enough for a typical compact to clear — rather than typed once into a
  session that can't hear it. Two tells queued for the same terminal are delivered in order.
- `cos-coord tell` now blocks on the app's delivery receipt (new — no receipt existed for any
  command before this; the outbox request format Brain 2.0 depends on is unchanged) and exits non-
  zero with the real reason whenever delivery didn't happen: an unresolved target, the retry window
  running out, or the terminal closing while the message was still queued. Exit 0 now means the
  message was actually seen on screen, not just that a file was written. See README "External
  dispatch" and `COS_COORD_TELL_WAIT_MS`.

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

**📖 Roles — a browsable, read-only wiki of every agent role**
- The role library the sessions read at start had no view. `Index.md` is a wall of table and the
  role files are 3–12KB each, so "what does the Sorter actually do, and what may it write?" meant
  opening a file and reading a page.
- A **full-window view** — not a modal, not a panel beside the terminals, not a workspace tab.
  Opened from the top bar, it takes the whole window and hides the terminal surface the same way
  an overlay does, so leaving it puts every workspace back exactly as it was. Escape closes it.
- One tile per role, grouped by surface: name, the **authority rung** (coloured, because it is the
  one word that says blast radius and it is what you scan a wall of tiles for), status, the first
  paragraph of `## Mission`, and the Custodian-review state — including the Charter's own staleness
  rule, so a review older than the last edit says so. An optional `summary:` frontmatter field
  overrides the Mission paragraph for the ones that crop badly; it is deliberately not required.
- Filters compose and are pure view state, nothing persisted: surface, rung, status, a search over
  name/mission/scope text, and **un-migrated**, which is off by default. An un-migrated role — one
  that lives only as a string literal in some app's source, or in a scheduled-task config — renders
  from its registry row plus the steps to migrate it, derived from what the registry says about
  where it lives. The gap should be actionable where it is visible.
- A coverage count ("8 of 14 roles have a role file") sits in the chrome. It says more about the
  health of the library than any individual tile.
- Clicking a tile opens the `.md`: `obsidian://` when a `.obsidian/` folder is found by walking up
  from the file, the OS default app otherwise or when nothing answers the URI, plus a 📁 reveal.
- **Nothing in the view changes the state of an agent.** The vault is the one writer over these
  files; the first editable field here is where a second source of truth begins. The single
  exception is library-level, not per-tile: *Review with Custodian* spawns a terminal on the
  `agent-custodian` role against the library folder, and only when that role file exists and is
  `status: active` — otherwise it says why, rather than starting a session that runs the generic
  folder-terminal prompt while calling itself the Custodian.
- With no `roleLibrary` configured the view opens and explains that; an unreadable folder (a
  stalled OneDrive placeholder) reports and offers a retry. Neither can break the app.
- Reads through the existing `role-library.ts` — one parse, so the view and the running sessions
  cannot disagree about what a role says. `Index.md`, `Charter.md`, `Summary.md` and
  `Custodian Reports/` are excluded from the role inventory using the Custodian's own Procedure
  step 2, so the app and the Custodian agree on what counts as a role.

**Connectors can now `tell` an existing terminal, not only `spawn` a new one**
- The connector channel below shipped `spawn`-only. The user's butler ("Brain 2.0") needed to
  hand work to a terminal that's already open, not just open new ones — the thing `cos-coord tell`
  already does for the overseer, with no external equivalent.
- Added a `tell` request kind: `{ kind: "tell", terminal, message }`, alongside `spawn`, both still
  the only permitted kinds — `watch`/`rename`/`personality` remain overseer-only. Receipt semantics
  match `spawn` exactly: `accepted` (with `terminalName`) only once the message is actually
  delivered, `rejected` with a reason otherwise (no such terminal, the name is ambiguous, the
  target is a journal tile, the message is over a 4000-character cap) — never silence, and never
  "accepted" without delivery.
- A connector may address any live terminal (matching the user's ask), but only one that already
  exists and by exact/unambiguous-case-insensitive name; unlike Kane's own `resolveTellTarget`, an
  ambiguous case-insensitive match is rejected rather than guessed at. No new rate limit beyond the
  size cap and the receipt-per-attempt trail — consistent with `spawn` never having had one either.
- No new roster mechanism: `floor/INDEX.md` already lists every live terminal's exact name and
  Brain 2.0 already reads it, so that's what a connector reads to pick a `terminal` value.
- `god-outbox/` and Kane's own `tell` are unchanged; connector `tell` goes through the same
  request/receipt path as connector `spawn`, not a second door into the outbox.

**Agent instructions read from role files instead of compiled-in strings**
- The worker terminal, folder terminal and overseer prompts existed only as TypeScript string
  builders, so changing how an agent behaves meant an edit, a build and a reinstall — which kills
  every session on the floor. New optional `roleLibrary: { path }` key in `config.json` points at a
  folder of markdown role files; each session's appended system prompt is then that role's prose
  plus a `## Session facts` block carrying the runtime values the builders used to interpolate.
- Roles are looked up by their `role:` frontmatter slug, never by filename, and only load at
  `status: active` — a renamed file keeps working, and a draft or retired directive cannot
  silently start governing a live session.
- Every failure falls back to the existing builder, which is unchanged and staying: no key, a
  missing folder, an unreadable file (these live in cloud-synced folders, where a placeholder can
  fail outright on read), no file with that slug, a non-active status. A session starting with *no*
  instructions is far worse than one running a slightly stale compiled default.
- Each session start logs `[roles] <slug> — vault (<file>)` or `— built-in (<reason>)`. Without it a
  loader that silently read nothing would be indistinguishable from a working one, and the feature
  would appear to work while doing nothing.
- Note this is a behaviour change, not a refactor: with a library configured, the agents start
  following the role files' text, which is not identical to the compiled strings.

**A real connector channel, separate from Kane's own outbox**
- The previous entry below documented `god-outbox/` as a supported integration point for any
  local process — that was wrong. It conflated two different actors: Kane's outbox carries the
  overseer's own privileged intent (`tell` into any terminal, `rename` anything, toggle
  `personality`), trusted because the overseer console *is* the app's own UI; an external app is a
  different actor that should be able to request work, not inherit that authority over every
  terminal on the floor. Writing both through one directory meant an external app silently gained
  the overseer's full command set, with no way to tell the two apart.
- New channel: `<coordDir>/connectors/<connectorId>/requests/` (in) and `.../receipts/` (out), one
  directory pair per connector. Connectors get **`spawn` only** — deliberately not `tell`/`rename`/
  `personality`. A connector must be registered in `config.json`'s new `connectors` list before its
  requests are honoured; an unregistered id gets a rejected receipt rather than being ignored.
- Every request drained now gets a receipt — `{ status: "accepted", terminalName }` or
  `{ status: "rejected", reason }` — instead of the old outbox's only signal being the file
  disappearing, which couldn't distinguish "accepted" from "rejected as malformed" from "unknown
  repo". Rejection reasons: connector not registered, envelope malformed, `kind` not permitted, or
  the repo is unknown. Receipts are the connector's to clean up; anything older than ~7 days is
  pruned on drain.
- Armed the same way the outbox already is — from grid construction, for every workspace,
  independent of the overseer console ever being opened. `god-outbox/` itself is unchanged; the
  README's "External dispatch" section now describes it as Kane's internal channel and points
  external integrations at connectors instead.

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
