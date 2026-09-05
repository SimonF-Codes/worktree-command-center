---
status: stable
---

# Private Overlay — design

**Date:** 2026-07-10
**Goal:** Keep Worktree Command Center open source while letting the author (or any user)
maintain personal features that never touch the public repo.

## Problem

The repo is public (MIT). Future personal-workflow features should stay private, and one
shipped feature (journal → Convert to Linear) hardcodes personal values: a Linear team name,
team UUID, and a personal MCP tool name (`src/terminals/linear-convert-probe.ts`). None are
credentials — a Linear team ID is unusable without an authenticated API key — so no history
rewrite is needed; removing them from current code and docs is enough.

## Decision

**Approach A — gitignored `private/` overlay with a build-time hook.** (Rejected: a private
fork with cherry-picks to public — high leak risk, permanent merge pain; a runtime plugin
system — clean but a large upfront API investment, can still evolve from A later.)

## 1. Repo layout

- Public repo: add `/private/` to `.gitignore`.
- New **private** GitHub repo (`wcc-private`) cloned at `private/` inside the working copy:

```
private/
  index.ts          # exports registerPrivateFeatures(api: PrivateApi): void
  features/...      # personal feature code; may import from ../src/** freely
  docs/             # specs/plans for private features live here, never in public docs/
  *.test.ts         # picked up by the same vitest run when the folder exists
```

## 2. Build wiring

- `src/private-api.ts`: defines the `PrivateApi` type.
- `src/private-stub.ts`: exports a no-op `registerPrivateFeatures`.
- `esbuild.config.mjs`: if `existsSync('private/index.ts')`, alias the virtual module
  `wcc-private` to it; otherwise alias to `src/private-stub.ts`.
- `tsconfig.json` `paths`: `"wcc-private": ["./private/index.ts", "./src/private-stub.ts"]`
  (tsc tries in order, so typechecking works with or without the overlay).
- `src/app.ts`: one call after setup — `registerPrivateFeatures(api)`.

**Initial `PrivateApi`** (grow only on real need):
`{ topBar, activeGrid: () => TerminalsGrid, config: { get, set }, toast, promptForTopic, userData, sidecarDir }`.

Result: a fresh public clone builds/runs with the stub; a clone with the overlay compiles
private features into the bundle with full TypeScript access to `src/`.

## 3. Genericize Convert to Linear

- `linear-convert-probe.ts`: the team name, team UUID, and save-issue tool name become
  parameters read from the existing app config (`getConfig`/`setConfig`, stored in
  `userData` — already outside the repo). Shape:
  `cfg.linearConvert = { team: string, teamId: string, saveIssueTool: string }`.
- `buildCreatePrompt` (and the create step) take these as arguments; tests use neutral
  fixture values.
- Unconfigured behavior: the Convert button stays visible; clicking without config shows a
  toast explaining what to add to the config file. No settings UI in v1.
- The author's real values move into local userData config during implementation.

## 4. Doc scrub + README

- Replace the team name and UUID in
  `docs/superpowers/plans/2026-06-26-journal-convert-to-linear.md` and
  `docs/superpowers/specs/2026-06-26-journal-convert-to-linear-design.md`
  (and the one mention in `2026-06-26-journal-entry-tile-design.md`) with `<your-team>` /
  `<team-uuid>` placeholders. Old history keeps the values; accepted (not secrets).
- Public README: one short paragraph documenting that `/private/` is a reserved, gitignored
  local-extension folder and what the `wcc-private` alias/stub is.

## 5. Going-forward rules

- Feature useful to any user → public repo; personal values in config.
- Personal workflow feature → `private/` repo via `registerPrivateFeatures`.
- Specs/plans for private features → `private/docs/`, never `docs/superpowers/`.

## Testing

- Existing vitest suite stays green with the stub (public CI path).
- `linear-convert-probe` unit tests updated to pass team/tool values explicitly.
- Manual check both ways: build with `private/` absent (stub) and present (hook called).

## Error handling

- Missing `linearConvert` config → toast with setup instructions; no crash, no probe spawn.
- `registerPrivateFeatures` failures must not take down the app: the call site wraps in
  try/catch and toasts on error.
