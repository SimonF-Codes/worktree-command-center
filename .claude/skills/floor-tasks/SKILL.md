---
name: floor-tasks
description: >
  Read the Worktree Command Center floor report (floor-report.json) and propose discrete,
  evidence-backed candidate tasks — parked work to land or drop, merged worktrees to prune, dirty
  or unmerged work nobody is holding, dormant targets to decide about, orphaned session groups —
  each citing the report facts that produced it and carrying a ready-to-use `cos-coord spawn`
  brief. PROPOSES ONLY; never spawns, edits or cleans anything. Use when the user asks what needs
  doing on the floor, what is stale or abandoned, what to clean up, "extrapolate tasks", "what
  should I work on", or says "/floor-tasks".
---

# Floor tasks: candidate work, extrapolated from the floor report

Turns the floor report into a short list of **candidate** tasks a person can accept or ignore.
The report says what the floor *is*; this says what that state *might call for* — and nothing more.

## The two rules this skill exists to keep

**1. It proposes. It never spawns.** Do not run `cos-coord spawn`, do not run the git commands in
a brief, do not edit, prune, park, close or message anything. The output is a list, in the chat,
and the skill ends there. If the person then picks a task, running its brief is their decision and
a separate step.

The reason is sharper here than anywhere else in the app: a generator that both invents work and
starts it is a machine for manufacturing plausible busywork. Half these repos are dormant **on
purpose**. Knowing which projects are asleep deliberately is exactly the knowledge this skill does
not have, so deciding what is worth doing stays with the person who does.

**2. Every task names the report facts that produced it.** Each one cites at least one fact from
`floor-report.json`, copied verbatim as `path = value`. A task that cannot point at a fact in the
report is a hallucination with a checkbox — plausible, specific-sounding, and invented. Do not
write it. This rule is load-bearing: it is the only thing that separates this list from
busywork, and a future edit that relaxes it breaks the skill.

## Finding the report

In order — use the first that exists, and state which one you read:

1. `$COS_COORD_DIR/../floor-report.json` — the in-app copy, rewritten on every worktree scan (~30s).
   Every session the app spawns has `COS_COORD_DIR` set.
2. `%APPDATA%/worktree-command-center/.coordination/floor-report.json` — the same file, found
   without the environment variable.
3. `<vault>/Personal/Code/floor-report.json` — the vault copy, at most a few minutes old, present
   only when the app has a role library configured.

Read the JSON, never the markdown: the markdown is a rendering of the same object for people.
Check `schema` is `1` (if it isn't, say the skill needs updating rather than guessing at fields)
and quote `generatedAt`. If it is more than an hour old, say so at the top: the app may be closed
and every fact below may have moved.

## How to read the facts (get these wrong and the tasks are wrong)

- **`null` means unknown, never zero or false.** Draw nothing from it.
- **`worktrees[].ahead` / `.behind` are counted against `.base`.** When both are `null` the branch
  was only compared with itself — a branch outside `wt/<base>-N` that no terminal holds — so the
  report makes **no** claim about whether it is merged. Never propose pruning such a worktree as
  "merged"; at most, list it as unmeasured.
- **`state: "clean"` with `ahead: 0` (not null)** means the branch has nothing its base lacks:
  removing the worktree and branch loses no commits. `behind` then only says how far base has moved on.
- **`state: "parked"`** means HEAD is a `wip: auto-parked …` commit: uncommitted work the app
  saved when a session closed. It is real work, not litter.
- **`heldBy`** is the live terminal sitting in that worktree, from every tab. A held worktree
  belongs to that terminal: never propose changing it — a task that touches another terminal's
  worktree breaks the floor's first rule.
- **`heldBy: null` does not mean abandoned.** A session closed from the memory panel keeps its
  worktree and branch so **Reopen** can bring it back, and its transcript is keyed by the worktree
  path. Removing an unheld worktree can remove someone's way back. Say so on every prune task.
- **`targets[].scanned: false`** means no grid has scanned it this launch (its tab has not been
  opened). Its zeroes are absence of data. Propose nothing for it except, at most, "not scanned".
- **`tabs[].liveTerminals: 0`** on a tab with `savedSessions > 0` means the tab has not been opened
  this launch — not that its sessions are gone.
- **`orphanSessionGroups`** are keys in the sessions file that no tab and no closed-tab tombstone
  owns. `savedSessions: 0` means an empty leftover; more than 0 means sessions nothing will restore.

## What to look for

Work down this list; each pattern names the fields that must hold. Rank the output by **risk of
losing work first**, clutter second, housekeeping last, and stop at about eight tasks — the point
is a list someone will actually read.

| Pattern | Facts that must hold | Candidate task |
|---|---|---|
| Parked, unheld | `state = "parked"`, `heldBy = null` | Land it or drop it |
| Dirty, unheld | `state = "dirty"`, `heldBy = null` | Commit, park, or discard — someone's uncommitted work |
| Unmerged, unheld | `state = "ahead"`, `heldBy = null` | Merge it or drop it |
| Merged clutter | per target: several worktrees with `state = "clean"`, `ahead = 0`, `heldBy = null`; cite `targets[].worktrees` and `.branches` | Prune them |
| Dormant target | `targets[].lastCommitAt` more than ~14 days before `generatedAt`, `worktrees > 0`; cite `held` either way — a terminal sitting in a repo that has committed nothing in weeks is evidence, not activity | **Decide**, not "work on it": resume or clean up |
| Orphan session group | an entry in `orphanSessionGroups` | Find how it outlived its tab, or remove it |
| Dead terminal | `terminals[].dead = true` | Close the tile — its session is gone |
| Memory leak signal | `totals.memory.unattributedBytes` ≥ 512 MB | Look in the memory panel |

A dormant target is the case this skill is most likely to get wrong. Present it as a question —
"nothing committed since 08-10 across 6 worktrees: asleep on purpose, or finished?" — and never as
work to resume.

## Output format

Start with one line: which report you read, its `generatedAt`, and how old it is. Then, per task:

```markdown
### 1. <imperative title, naming the repo and branch>

**Evidence** (floor-report.json, generated <generatedAt>):
- `worktrees[repo=worktree-command-center, branch=wt/main-7].state = "parked"`
- `worktrees[repo=worktree-command-center, branch=wt/main-7].ahead = 1`
- `worktrees[repo=worktree-command-center, branch=wt/main-7].heldBy = null`

**Why it might not be worth doing:** <the honest counter-case — dormant on purpose, a Reopen
route it would remove, cosmetic only>

**Brief** (run by you, or by Kane on your word — not by this skill):
    cos-coord spawn "worktree-command-center" --base "main" --name "land-main-7" --task "…"
```

Select rows by identifying fields (`repo`, `branch`, `key`, `name`), never by array index: indexes
shift between refreshes and the evidence has to stay checkable.

Close with a short **Not proposed** list: facts you looked at and deliberately turned into no task
(held worktrees, unmeasured branches, unscanned targets), so the person can see what was left out
and why.

## Writing the brief

`cos-coord spawn` is `cos-coord spawn "<repo>" --base "<branch>" --task "<brief>" [--name "<name>"]`
(`--model` / `--effort` optional). Only the overseer role may run it. The brief must:

- Name the target by its `targets[].name` and the base branch to cut from.
- Restate the evidence in one sentence, and tell the worker to **re-verify it first** — the
  report may be minutes old and the floor moves.
- Say what "done" means and what the worker must report back.
- Use git's refusing forms for anything destructive: `git worktree remove <path>` (refuses on a
  dirty tree — never `--force`) and `git branch -d <branch>` (refuses when unmerged — never
  `-D`). Tell the worker to skip and report anything held by a live terminal
  (`cos-coord status`, `worktrees.md`) rather than touch it.
- Contain no unescaped double quotes, so it survives the shell as one `--task` argument.

For a pure decision — a dormant target, say — write a **read-only** brief: inventory what each
worktree branch holds against its base and recommend keep or remove, changing nothing. A
decision task must not arrive with the decision already carried out.

Some findings have no repo to spawn into (a dead tile, a memory warning). Mark those
**Manual** with the exact click path instead of a brief, rather than inventing a code task to
carry them.
