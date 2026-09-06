---
status: stable
---

# Kane Watchers & Spawn — Design

> Status: approved design, pre-implementation. Date: 2026-06-09.
> Builds on: `2026-06-07-god-overseer-console-design.md` (the Kane console + `cos-coord tell` channel).

## 1. Goal

Give Kane (the overseer console) two new abilities, driven by natural-language requests from
the user:

1. **Watchers** — "when terminal X finishes, do this." Kane registers a watch on a worker
   terminal; when that terminal finishes, Kane is notified and carries out the queued action
   with his own tools.
2. **Spawn** — Kane can create a new worktree terminal and start it off with an initial task.

Both extend the existing Kane→grid command channel (`cos-coord` → `god-outbox/` → grid drain),
the same path `cos-coord tell` already uses.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Watcher fire action | Notify Kane (inject a line into his console); Kane reasons + acts. Not a canned auto-send. |
| What "finishes" means | The terminal's next idle/ready event, **skipped** if it's just sitting on a permission/selection prompt (`looksLikePrompt`/`looksLikeMenu`). |
| Watcher lifetime | One-shot (fires once, then removed). In-memory — cleared on app restart / tab unmount. |
| Spawn inputs | repo name + base branch + initial task. Base defaults to the repo's main/master if omitted. |
| Command surface | Extend `cos-coord` with Kane-only `watch` and `spawn` verbs (gated by `COS_ROLE=god`), consistent with `tell`. |

## 3. Architecture

### 3.1 New `cos-coord` verbs (Kane-only)

In `pty-sidecar/coord-cli.cjs`, gated by `COS_ROLE === 'god'` (same gate as `tell`):

- `cos-coord watch "<terminal>" --note "<what to do when it finishes>"`
- `cos-coord spawn "<repo>" [--base "<branch>"] --task "<initial prompt>"`

Each writes one **atomic** JSON file (temp + rename) into `coordDir/god-outbox/`, tagged with a
`kind` field so the grid can dispatch:

```jsonc
{ "ts": 0, "kind": "tell",  "target": "Improver 1", "message": "rebase" }
{ "ts": 0, "kind": "watch", "target": "Improver 1", "note": "tell me, then run the tests" }
{ "ts": 0, "kind": "spawn", "repo": "app", "base": "main", "task": "implement X" }
```

`coord-store.cjs` gains `watch(dir, target, note)` and `spawn(dir, repo, base, task)` alongside the
existing `tell` (each just drops a tagged outbox file). The existing `tell` payload stays
back-compatible (missing `kind` ⇒ treated as `tell`).

### 3.2 Outbox parsing (pure, in `god.ts`)

Generalize `parseTellRequest` → `parseOutboxMessage(text)` returning a discriminated union:

```ts
type OutboxMessage =
  | { kind: 'tell';  target: string; message: string }
  | { kind: 'watch'; target: string; note: string }
  | { kind: 'spawn'; repo: string; base: string | null; task: string };
```

Returns `null` on malformed input. A message with no `kind` but a `target`+`message` is read as
`tell` (back-compat). `resolveTellTarget` is reused to map `target` → a live terminal name.

### 3.3 Grid: drain dispatch (`terminals-grid.ts`)

`drainOutbox()` parses each file with `parseOutboxMessage` and dispatches by `kind`:

- `tell` → existing behavior (resolve target, `tile.sendLine(message)`, else god-inbox error).
- `watch` → resolve target to a live terminal name; if found, push `{ target, note }` onto the
  in-memory `watchers` list; else write a god-inbox error so Kane re-reads `floor/INDEX.md`.
- `spawn` → `void this.spawnFromKane(repo, base, task)`.

### 3.4 Watchers

- Field: `private watchers: Array<{ target: string; note: string }> = []`.
- Fired from the **top** of `handleReady(t)` — before the `hidden`/`chatRoom`/centering logic — so
  it works for any terminal, including hidden/background ones:

  ```ts
  // Fire any one-shot watch whose target just finished (idle and NOT stalled on a prompt).
  if (this.watchers.some((w) => w.target === t.name)) {
    const out = t.recentOutput();
    if (!looksLikePrompt(out) && !looksLikeMenu(out)) {
      const fired = this.watchers.filter((w) => w.target === t.name);
      this.watchers = this.watchers.filter((w) => w.target !== t.name);
      for (const w of fired) {
        this.godConsole?.notify(`[watch] terminal "${t.name}" finished — you asked: ${w.note}`);
      }
    }
  }
  ```

- `looksLikePrompt` is imported from `chat-room.ts`; `looksLikeMenu` from `prompt-detect.ts`.
- If `godConsole` is null (Kane fully closed), `notify` is a no-op guard — the watch simply doesn't
  fire (Kane isn't around to act).

### 3.5 `GodConsole.notify(text)`

A new method that types `text` + Enter into Kane's pty (mirrors `TerminalTile.sendLine`: write the
text, then a separated `\r` on a later tick so ConPTY doesn't coalesce it):

```ts
notify(text: string): void {
  this.bridge?.write(text);
  setTimeout(() => this.bridge?.write('\r'), 40);
}
```

### 3.6 Spawn

- Refactor the body of `play()` into a shared core so the Play button and Kane use one path:

  ```ts
  private async spawnWorktree(repo: RepoConfig, base: string, opts: { task?: string }): Promise<TerminalTile | null>
  ```

  It does what `play()` does today (compute branch via `nextWorktreeBranch`, `createWorktree`,
  `makeTile`, render, push, `persist`, `applyLayout`), and if `opts.task` is set, records it as the
  tile's pending initial task. `play()` becomes: resolve repo+base from the dropdowns, call
  `spawnWorktree(repo, base, {})`.

- `spawnFromKane(repoName, base, task)`: find the repo by name (god-inbox error if unknown); if
  `base` is null, use `defaultBranch(await listBranches(repo.path))`; call
  `spawnWorktree(repo, base, { task })`.

- **Initial-task delivery:** a `private pendingTask = new Map<number, string>()` keyed by tile id.
  `spawnWorktree` sets it when `opts.task` is present. In `handleReady(t)`, after the watcher
  check, if `pendingTask` has `t.tileId`, `tile.sendLine(task)` once and delete the entry — so the
  task is sent the moment the fresh claude session is first ready to receive it.

### 3.7 Kane's system prompt (`god.ts`)

Document the two new commands under "ACTING":

- `cos-coord watch "<exact terminal name>" --note "<what you'll do when it finishes>"` — you'll be
  pinged here when it finishes (not while it's just paused on a prompt), then do the thing.
- `cos-coord spawn "<repo>" --base "<branch>" --task "<first instruction>"` — opens a new worktree
  terminal and starts it on that task. Repo names + paths are listed below; base is optional.

## 4. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Watch fires early on a mid-task idle | "Skip prompt-stalls" covers the common stall; one-shot + Kane can re-arm. Documented as a v1 heuristic. |
| Watch target not a live terminal | `resolveTellTarget` → null → god-inbox error message; not registered. |
| Kane closed when a watch would fire | `notify` no-ops on null `godConsole`; watch stays unfired (Kane gone). |
| Spawn for an unknown repo | god-inbox error; no spawn. |
| Initial task sent before claude is ready | Delivered on the tile's first `onReady`, not immediately after spawn. |
| Injecting into Kane while he's typing | Rare; the line queues in Claude's input box. Acceptable for v1. |
| Watchers lost on restart | In-memory by design (v1). Kane re-arms. Noted as a follow-up. |

## 5. Testing

Pure units (mirror existing `tests/*.test.ts`):
- `parseOutboxMessage` — each `kind`, back-compat `tell` (no `kind`), malformed → null, missing
  fields → null, `spawn` with/without `base`.
- A small `watchShouldFire(output)` predicate (`!looksLikePrompt && !looksLikeMenu`) — fires on
  normal "done" output, not on a permission/selection prompt.
- `godSystemPrompt` now mentions `cos-coord watch` and `cos-coord spawn`.
- Extend `coord-store`/`coord-cli` tests: `watch`/`spawn` drop well-formed tagged files and no-op
  without `COS_ROLE=god`.

Integration (manual): arm a watch on a worker, let it finish → Kane gets the ping. `cos-coord spawn`
opens a worktree and the task lands once it boots.

## 6. Out of scope (v1)

- Repeating / cron / time-based watches (only "next finish").
- Cross-restart persistence of watchers.
- Watching for things other than "finished" (e.g. "when X errors", "when X prints Y").
- Kane auto-watching terminals he spawns (he can `watch` them explicitly).
