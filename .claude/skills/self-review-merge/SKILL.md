---
name: self-review-merge
description: >
  Review and land the self-review branch onto main. Fetches origin's self-review/auto (the branch
  the scheduled /self-review routine pushes to), verifies it integrates green against the current
  main (build + full test suite), summarizes each optimization commit, and — only if verification
  passes and you approve — merges it into main and pushes. Use when the user wants to review, land,
  or merge the automated self-review work, or says "/self-review-merge".
---

# self-review-merge: land the automated self-review work onto main

Companion to `/self-review`. The scheduled self-review routine pushes test-gated optimization commits
to the `self-review/auto` branch on the fork; this skill reviews that branch and merges the good work
into `main`. Manual, human-in-the-loop by design.

## Guardrails

1. **Never merge red.** Merge into `main` ONLY after the integrated result (main + self-review/auto)
   passes `npm run build` and `npm test`. If it doesn't, do NOT merge — report which commit(s) look
   responsible and stop.
2. **Verify against CURRENT main.** `self-review/auto` may have been branched from an older main.
   Always test the *integration with today's main*, not the branch in isolation.
3. **Human approval before the merge + push.** Present the summary and the verification result, then
   merge only on the user's go-ahead (they're present — this is a manual skill).
4. **Work in a throwaway worktree**, never `main`'s primary checkout (repo discipline). Clean it up
   after.
5. **Push main is the only outward action.** Do not force-push, do not delete the self-review branch
   unless the user asks (it may accrue more commits from the next routine run).

## Environment facts (this repo)

- Node v22: `export PATH="/Users/simon/.nvm/versions/node/v22.23.1/bin:$PATH"`.
- Build: `npm run build`  ·  Test: `npm test` (vitest).

## Protocol

1. **Fetch.** `git fetch origin main self-review/auto`. If `origin/self-review/auto` doesn't exist
   or has no commits ahead of `main`, report "nothing to merge" and stop.
2. **Set up an integration worktree** off the latest `main`:
   `git worktree add <tmp> -b integrate/self-review origin/main`.
3. **Summarize the incoming work.** `git log --oneline origin/main..origin/self-review/auto` — each
   commit is one test-gated optimization (message starts `self-review: …`). List them for the user
   with the files touched (`git diff --stat`).
4. **Integrate + verify.** In the worktree: `git merge --no-ff origin/self-review/auto` (resolve any
   conflicts conservatively — prefer main on ambiguity, or stop and ask if non-trivial). Then
   `npm install` if needed, `npm run build`, `npm test`.
   - **Red:** discard (`git merge --abort` / drop the worktree), report the failure + likely commit,
     stop. Optionally offer to cherry-pick only the commits that pass individually.
   - **Green:** continue.
5. **Approve + land.** Show: commits landing, files changed, "build + N tests green." On the user's
   go-ahead, fast-forward or merge `integrate/self-review` into `main` in the primary checkout and
   `git push origin main`. (No app rebuild needed unless the changes touched shipped app code — if
   they did, offer to rebuild/redeploy per the usual flow.)
6. **Clean up.** Remove the integration worktree + branch. Leave `self-review/auto` as-is (the
   routine keeps appending to it) unless the user asks to reset it.
7. **Report.** What landed on main, the new main commit, verification result, and anything skipped.

## Notes

- Each self-review commit was individually build+test-gated when created, so a clean integration is
  the common case; the value here is re-verifying against a main that has since moved and giving you
  the final say before it lands.
- If the routine has pushed many commits, it's fine to land them as one batch (this skill verifies
  the whole set together).
