# Step 11 performance profile — `wcc-team metrics` and the Project panel

V2 Team Floor NFR-2: *the panel does not ship until a profile over roughly ten workspaces is in the
pull request, and `wcc-team metrics` prints its own wall time and the git calls it made.* This is
that profile. It was measured, not estimated: every figure below is the median of five runs of the
bundled CLI (`pty-sidecar/wcc-team.cjs`), or of forty iterations for the in-window tick.

**Verdict: the profile is good, and the panel ships.** The panel's own call costs ~130 ms end to end
in a child process, two git calls, at most once per five minutes. The one cost that runs on the
window's thread — the panel's 1.5 s live tick — was 32 ms at stress size before this step fixed it,
and is 0.6 ms after.

## Where the cost lands

| What | Thread | When |
| --- | --- | --- |
| `wcc-team metrics --json --workspace <active>` | **a child process** (spawned by the main process via `runCommand`; git runs in *its* children) | when the panel opens, then at most every 5 min while it is open |
| live tick: fold `workstreams.jsonl` + `spawn-proposals.jsonl`, preview each open proposal, build the view | the window's (renderer) thread | every 1.5 s while the panel is open; nothing while it is closed |
| `attention.jsonl` append | the window's thread | on a classifier **transition** only — never per tick |

## Machine and data

Windows 11, Node v22.23.2, git 2.47.1.windows.2, run in a worktree of this repo on 2026-11-22.
The real data is this machine's own app folder: **10 workspaces**, 7 of which resolve to a repo
(7 distinct repos; 3 have none), the Simon-Brain vault configured, `worktree-command-center` with
115 commits on `main` in the 44-day history window. No workstream, attention or isolation log
existed yet, which is today's state for every user.

## Real data

| Run | spawn → exit | `wcc-team` wall | git calls | git ms (summed) | slowest call | JSON |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all 10 workspaces | **317 ms** | 274 ms | 14 | 1623 | 193 ms | 43 KB |
| `--workspace default` (the panel's call) | **131 ms** | 88 ms | 2 | 80 | 43 ms | 8 KB |
| `--workspace brain-2-0` | **115 ms** | 74 ms | 2 | 70 | 37 ms | 4 KB |

"spawn → exit" includes Node's start-up (~20 ms of process time before `main` runs) and is what a
refresh costs the app. Git runs **once per distinct repo**, however many workspaces share it, two
calls each (`for-each-ref` for the mainline and tags, one `log` over the window plus 30 days), all
repos at once — so 14 calls for 7 repos run in ~275 ms of wall time though they sum to 1.6 s.
Its own stderr, from one of those runs:

```
wcc-team: 10 workspaces, 7 repos · wall 336 ms (process 356 ms) · 14 git calls, 1911 ms summed
  git -C C:\dev\worktree-command-center for-each-ref "--format=…" refs/heads/main refs/heads/master refs/tags → 0 · 66 ms · 1 KB
  git -C C:\dev\worktree-command-center log --since=2026-10-09 "--format=…" main → 0 · 218 ms · 98 KB
  … (12 more, one pair per repo)
```

## Stress: a year of heavy use

Same 10 workspaces and repos, plus synthetic coordination logs in **every** workspace: 300
workstreams with 8 tasks each (0.6 MB), 100 000 attention transitions with a boot every 5 000
(7.6 MB), 2 000 isolation records (0.4 MB) and 500 proposals (0.1 MB) — 87 MB of logs in all.

| Run | spawn → exit | `wcc-team` wall | git calls | JSON |
| --- | ---: | ---: | ---: | ---: |
| all 10 workspaces | **1373 ms** | 1313 ms | 14 | 827 KB |
| `--workspace default` (the panel's call) | **268 ms** | 217 ms | 2 | 86 KB |

All of it in the child process: the window does not wait on it (`runCommand` is asynchronous).

## The live tick, on the window's thread

| | median | p95 |
| --- | ---: | ---: |
| before: re-read and re-fold both logs, and re-read the proposals log once per previewed proposal (30) | 32.2 ms | 37.9 ms |
| **after**: `foldCached` re-folds a log only when its size or mtime moved | **0.6 ms** | 1.2 ms |

32 ms every 1.5 s is two dropped frames on every tick, and the Manager view and the sidebar's ◆N
were paying the same per-tick re-fold on `spawn-proposals.jsonl`. `src/terminals/append-log-cache.ts`
fixes it for all three: an append-only log that changed has changed size, so `(size, mtime)` is a
sound key. The first tick after an append pays the fold once (27 ms at stress size).

## Reproduce

```sh
npm run build
node pty-sidecar/wcc-team.cjs metrics --json > /dev/null            # every workspace; cost on stderr
node pty-sidecar/wcc-team.cjs metrics --json --workspace default > /dev/null
```

The harness that produced the medians spawned the CLI five times with `spawnSync` and read
`timing` from its JSON; the stress logs were generated into a copy of the app folder passed with
`--user-data`. Neither is committed — the CLI's own stderr is the instrument.
