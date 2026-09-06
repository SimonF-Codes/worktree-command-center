---
status: stable
---

# Session-Env Provider — design

**Date:** 2026-07-13
**Goal:** Let an overlay (or any future caller) inject extra environment variables into every
`claude` session the app spawns, per workspace — a generic capability with no policy baked in.

## Problem

All `claude` processes are spawned through `SessionBridge`, which already accepts an
`extraEnv` map, but nothing user-extensible feeds it. Overlay features (see README
"Private extensions") cannot influence spawn environments — e.g. to point sessions at a
different `CLAUDE_CONFIG_DIR` profile — without patching internals.

## Design

### Provider

One optional provider function, set by the overlay via `PrivateApi`:

```ts
type SessionEnvProvider = (ctx: { workspaceId: string }) => Record<string, string>;
```

- Default (no overlay / not set): treated as `() => ({})` — zero behavior change.
- Consulted lazily at each spawn, so changing the provider (or its answer) affects future
  spawns only; running sessions keep the env they started with.
- Every consultation is wrapped in try/catch at the call site; a throwing provider yields
  `{}` and must never break spawning.

### Threading

- `GridDeps` gains `sessionEnv?: () => Record<string, string>`. `app.ts`'s `depsFor(id)`
  binds the provider to the grid's workspace: `() => provider({ workspaceId: id })`.
- The grid passes it to every spawn it owns:
  - terminal tiles and the god console (merged into the env they already assemble),
  - `FormatProbe` and `LinearConvertProbe` (new optional `sessionEnv` in their opts,
    merged at spawn time inside `run()` — the probes are constructed once but run later).
  (The chat room spawns no `claude` of its own — it coordinates existing tiles — so it
  needs no threading.)
- The app-level `UsageProbe` is created with `() => provider({ workspaceId: activeId })`
  and the app exposes `restartUsageProbe()` (dispose + recreate probe and battery widget)
  so a provider change can be reflected in the battery.

### PrivateApi additions

```ts
initialConfig: any; // startup config snapshot — synchronous read inside the hook
setSessionEnv(provider: SessionEnvProvider): void;
activeWorkspaceId(): string;
onWorkspaceSwitch(cb: (id: string) => void): void;
restartUsageProbe(): void;
```

### Hook timing

`registerPrivateFeatures(...)` moves from the end of `main()` to before the first grid
mount: session restore spawns terminals during that mount, and those must already see the
provider. Everything the hook's api object captures (`topBar`, closures over `activeGrid`,
config fns) exists before the mount.

## Error handling

- Provider throws → `{}` for that spawn (call-site try/catch), no toast spam.
- `restartUsageProbe()` is safe to call repeatedly; it disposes the old probe first.

## Testing

- Pure helper (if extracted) for merging provider env into spawn env: unit-tested.
- Existing suite must stay green with no provider set (public path unchanged).
- Overlay-side behavior is tested in the overlay's own repo.

## Non-goals

- No account/profile logic in the public repo — the provider's CONTENT is the overlay's
  business. No per-tile env UI. No settings surface.
