# Review notes — items needing follow-up

_Refreshed 2026-09-07. `main` @ `9d43bfe` (release 0.6.0), synced with `origin/main`._

## Resolved this pass ✅

- **Disk full → sessions couldn't start.** Root cause was a full APFS container (node-pty couldn't
  spawn). Freed ~12 GB by deleting stale `release/`/`*.dmg` artifacts, worktree `node_modules`, and
  safe regenerable caches (installer/package/ShipIt-updater caches, npm cache). Sessions verified
  spawning again.
- **Installed app was behind `main`.** Rebuilt from current `main` (0.6.0) and reinstalled to
  `/Applications`. Signed with the local "Worktree Command Center Dev" identity (signature valid).
  Verified: app launches (HTTP 200) and the packaged sidecar spawns `claude` sessions cleanly.
- **Corrupted `node_modules`** (missing `bluebird` files from the disk-full period) — fixed with a
  clean `rm -rf node_modules && npm ci`. Full suite green: **345 passed / 2 skipped (39 files)**.

## 1. Self-review optimizations — now stale-based, needs rebase before landing  ⚠️

- `origin/self-review/auto` holds 2 test-gated optimization commits, but `main` has since advanced
  **~38 commits** past their base, so the earlier `integrate/self-review` merge is superseded.
- **To land:** re-verify against *current* `main` — the `/self-review-merge` routine fetches
  `self-review/auto`, rebuilds + runs the full suite against `main`, and only merges if green. Don't
  reuse the old `integrate/self-review` branch; it's based on a pre-0.6.0 `main`.
- An active `self-review-auto` worktree exists (used by the scheduled `/self-review` routine) — left
  in place; not stale.
- Stale to clean up eventually: `origin/integrate/self-review` (superseded).

## 2. Build environment gotcha

- Default `node` on PATH is **v14** — too old to build. Builds/tests must use nvm's Node 22:
  `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`. The dev desktop `.command` already
  pins this.
- `package-lock.json` drift from a stray `npm install` was discarded; canonical lock installs clean
  via `npm ci`.

## 3. Feature backlog (SSH/roles/settings plan — not started)

- **P1** roles + goal-classified subagents (pre-req: confirm `.claude/agents/*.md` `model:` frontmatter
  is honored by the installed claude before wiring).
- **P2** unified Settings page restructure.  **P3** SSH remote workspaces.  **P4** full remote
  worktree lifecycle.
