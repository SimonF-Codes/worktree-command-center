# Review notes — items needing follow-up

_Snapshot taken 2026-07-22 while clearing a full-disk incident. `main` is at the tip that includes
the recently-merged CI pipeline + feature PRs._

## 1. Self-review work not yet landed on `main`  ⚠️ needs test verification

- The `/self-review` routine produced two test-gated optimization commits on **`origin/self-review/auto`**:
  - `96cc69a` — add unit tests for `resolveEditorCommand` (`tests/editor-launch.test.ts`, +35 lines, additive).
  - `9f4c63d` — remove confirmed-unused dead code (`setMaximized`/`maxBtn`/`centeredTile`/`parentEl`)
    in `src/terminals/terminals-grid.ts` (−15 lines). The intentional chat dead-code was left alone.
- These were merged into current `main` on branch **`origin/integrate/self-review`** (pushed). The
  merge was **clean** and `npm run build` **passed**, BUT `npm test` **never ran** — it was blocked
  by the full disk (vitest failed to import; environmental, not a code failure).
- **To land it:** in a fresh worktree off `main`, `npm install`, `npm test`. If green (and on
  approval), fast-forward/merge `integrate/self-review` into `main` and push. Guardrail: do NOT
  merge until the suite is actually green. (`/self-review-merge` automates this.)

## 2. Installed app is behind `main`  ⚠️ rebuild + reinstall pending

- `/Applications/Worktree Command Center.app` predates the latest `main`, which now includes: the
  GitHub Actions CI/release pipeline, per-tab attention markers + notifications, chat Up/Down
  history recall, the "claude CLI not on PATH" warning, and the usage-probe fix for CLI 2.1.211's
  tabbed `/usage` screen.
- A packaged rebuild (`npm run dist:mac`) + reinstall is needed to get these into the running app.
  **Blocked on disk headroom** — electron-builder needs several GB of temp; currently only ~1.3 GB
  free (see §3). Do this once there's room.

## 3. Disk space is tight

- An APFS-container full-disk incident blocked builds/tests and even command-output capture. Cleared
  by deleting all stale `release/` dirs, `*.dmg`/zip artifacts, and worktree `node_modules` → ~1.3 GB
  free. Enough for the app + sessions, NOT enough for a comfortable packaged build. Free more before
  the next `dist:mac` (other volumes/snapshots, Xcode, `~/Library/Caches`, Downloads).

## 4. Done in this pass

- Sessions were failing to start — root cause was the full disk (node-pty couldn't spawn). Fixed by
  freeing space; verified the installed sidecar now spawns `claude` cleanly; restarted the app.
- Local `main` fast-forwarded to `origin/main` (`acc7d9a`).
- Stale worktrees trimmed: removed `wt-main-4` (+ its stale `wt/main-4` branch — pre-timestamp-scramble
  duplicates of work already on `main`) and the `wt-integrate` worktree (its branch is preserved on
  origin + locally).
- Desktop shortcuts created: `Worktree Command Center.app` (symlink → installed build) and
  `Worktree Command Center (dev).command` (builds + runs from source).

## 5. Feature backlog (from the SSH/roles/settings plan — not started)

- **P1** roles + goal-classified subagents (pre-req: confirm `.claude/agents/*.md` `model:` frontmatter
  is honored by the installed claude before wiring).
- **P2** unified Settings page restructure.  **P3** SSH remote workspaces.  **P4** full remote
  worktree lifecycle. See the plan doc discussed in-session.
