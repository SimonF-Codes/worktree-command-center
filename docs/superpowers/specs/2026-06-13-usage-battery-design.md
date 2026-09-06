---
status: stable
---

# Usage Battery — Design

> Status: approved design, pre-implementation. Date: 2026-06-13.

## 1. Goal

A compact "battery" indicator in the top-right of the Worktree Command Center topbar showing
how much of the user's Claude limit is left: the **current-session %** (the 5-hour window) as a
battery + its reset time, and a clean **weekly %** + reset line. Updated **only** when the user
clicks a ⟳ refresh button — never auto-polled.

## 2. Reality / constraint (why it works this way)

Claude exposes **no** machine-readable usage API (no CLI JSON flag, no `~/.claude/usage.json`, no
endpoint, no rate-limit headers for subscription users). The only source of plan-usage numbers is
the interactive **`/usage`** command, and its figures are **approximate and device-local** (this
machine's sessions only — not claude.ai web or other devices). So the indicator drives `/usage` in
a hidden Claude session and scrapes the rendered output. `/usage` is a local command and consumes
**no** tokens/limit.

A real `/usage` capture (2026-06-13) confirms the parseable shape:

```
Current session            ██████████████▍ 28% used   Resets 3:50am (America/New_York)
Current week (all models)  ███ 6% used                Resets Jun 15, 12am (America/New_York)
Current week (Sonnet only) ▌ 1% used                  Resets Jun 14, 11:59pm (America/New_York)
Usage credits              ...46▎ 92% used   $13.88 / $15.00 spent · Resets Jul 1 (America/New_York)
```

## 3. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Meters shown | **Session** (battery % + reset time) and **Weekly** (all-models % + reset). No credits meter. |
| Refresh | **Manual only** — a ⟳ button. No periodic polling. |
| Data source | Scrape `/usage` from a hidden Claude session. |
| Probe lifecycle | **Lazy + reused** — spawn on first ⟳, keep alive (idle, no token use) for fast later refreshes, kill on app teardown. |
| "Time" shown | The reset clock string `/usage` gives (e.g. `resets 3:50am`), not a live countdown (no auto-refresh to keep a countdown honest). |

## 4. Architecture — three units

### 4.1 `parseUsage(text)` — pure (`src/terminals/usage-parse.ts`)

Input: the ANSI-stripped `/usage` buffer text. Output:

```ts
export interface UsageReadout {
  sessionPct: number | null;   // current session (5-hour window)
  sessionReset: string | null; // e.g. "3:50am (America/New_York)"
  weekPct: number | null;      // current week (all models)
  weekReset: string | null;    // e.g. "Jun 15, 12am (America/New_York)"
}
export function parseUsage(text: string): UsageReadout;
```

Robust to the box-drawing/spacing noise: locate each section label tolerantly
(`/current\s*session/i`, `/current\s*week\s*\(all\s*models\)/i`), then within the text that follows
capture the next `(\d+)\s*%\s*used` and the next `resets\s*<…>`. Missing fields → `null` (never
throws). Unit-tested against the captured sample (with and without collapsed spaces).

### 4.2 `UsageProbe` — drives the hidden session (`src/terminals/usage-probe.ts`)

Reuses `SessionBridge` (the same node-pty wrapper the tiles use). No worktree, no UI.

- `constructor(opts: { sidecarPath: string; cwd: string })`.
- `async refresh(): Promise<UsageReadout>`:
  1. `ensureSession()` — lazy-spawn `claude` (no special args) in `cwd`, accumulating all output
     into a buffer via `onData`. Reuse the live session on later calls.
  2. Reset the capture buffer, `send('/usage\r')`.
  3. Poll the buffer (~every 400ms, hard cap ~12s): considered **settled** once `parseUsage` returns
     a non-null `sessionPct` **and** the "Scanning…/Refreshing…" spinner text is absent from the
     tail. (Belt: also stop at the timeout and parse whatever's there.)
  4. `send('\x1b')` (Esc) to leave the usage view so the session is reusable.
  5. Return the parsed `UsageReadout`.
- `dispose()` — kill the session.
- **cwd:** a registered repo path (already a trusted folder), falling back to the app's userData
  dir. (A first-run folder-trust prompt would block `/usage` — see risks.)

### 4.3 `UsageWidget` — the topbar UI (`src/ui/usage-widget.ts`)

- `render(parent)` builds: a battery (`<div class="wcc-batt">` with a fill bar), a `% · resets …`
  label, a `Week N% · resets …` line, a ⟳ button, and a faint "updated …" / "approx · this
  machine" note.
- ⟳ click → disable button + show a spinner, `await probe.refresh()`, fill the battery to
  `sessionPct` (CSS width %), color by threshold (≤60 green, ≤85 amber, else red), set the labels,
  stamp "updated just now". On error/timeout → "couldn't read usage — try again".
- Before the first refresh: battery empty, label "tap ⟳ for usage".
- No timers. Reads nothing on its own.

### 4.4 Wiring (`src/app.ts`)

The topbar already has `wcc-brand` + add-folder + `wcc-status`. Add the `UsageWidget` to the right
end of the topbar. The probe needs `sidecarDir` (already fetched via `window.wcc.paths()`) and a
cwd (`repos[0]?.path ?? userData`). Dispose the probe on window unload.

## 5. Visual

```
🌳 Worktree Command Center            3 repos    [▮▮▮▮▮▯ 28%] resets 3:50am   Week 6% · Jun 15   ⟳
                                                  └ green/amber/red by %        (faint) approx · this machine
```

## 6. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| `/usage` TUI format changes | Parser is tolerant (label-anchored regex, optional spaces); fields degrade to `null` and the widget shows "—" rather than breaking. |
| Folder-trust prompt on first spawn blocks `/usage` | Spawn in a registered repo path (already trusted). If the probe times out, the widget shows "couldn't read usage — try again". (Auto-accepting trust is a possible later refinement.) |
| Scan not settled when scraped | Poll-until-settled (sessionPct present + no spinner) with a 12s cap; reset string also required for the session line before declaring settled. |
| Hidden session lingering | Idle, consumes no tokens; killed on teardown. |
| Number is device-local / approximate | Explicit faint "approx · this machine" note (matches `/usage`'s own disclaimer). |
| Probe spawn fails (no claude) | `refresh()` rejects → widget shows the error state. |

## 7. Testing

- **`tests/usage-parse.test.ts`** — `parseUsage` against the real captured sample: extracts
  session 28% + "3:50am", week 6% + "Jun 15"; tolerant of collapsed spaces
  (`Currentsession…28%used…Resets3:50am`); missing sections → `null`; junk → all `null`.
- `UsageProbe`/`UsageWidget` are I/O + DOM (verified by build + manual): click ⟳, confirm the
  battery fills to the session % and the weekly line matches what `/usage` shows in a terminal.

## 8. Out of scope (v1)

- Auto-refresh / live countdown to reset.
- The `$` usage-credits meter and the Sonnet-only weekly meter.
- Cross-device / true-account usage (impossible without an official API).
- Auto-accepting a folder-trust prompt.
