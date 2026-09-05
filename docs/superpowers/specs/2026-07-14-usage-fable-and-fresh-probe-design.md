---
status: stable
---

# Usage Battery: Fable Readout + Fresh-Session Refresh — design

**Date:** 2026-07-14
**Goal:** The battery shows Fable weekly usage alongside session/week, and the ⟳ refresh
returns real numbers every time instead of only on the first press.

## Root cause (refresh-once bug)

`UsageProbe` reuses one hidden `claude` session across refreshes (an Esc parks the usage
view). But the CLI fetches limit data ONCE per process and re-renders that snapshot on
every reopen. Proven empirically (two `/usage` passes in one session via the sidecar):
the second pass genuinely ran — the session's own wall-clock stat advanced — yet every
limit value came back byte-identical, with no fetch/scan indicator in either pass. A
reused session therefore can never refresh; the widget code was never the problem.

## Fix

- `UsageProbe.refresh()` disposes the session after scraping (no Esc-and-park). Every
  refresh boots a fresh `claude`, which must fetch real numbers. Cost: ~8–12 s per
  refresh (the first press always cost this); the ⏱ auto-refresh just does the same
  every 60 s.
- The probe's cwd moves from `repos[0].path` to a dedicated `<userData>/usage-probe`
  dir (created best-effort at probe construction). Per-refresh sessions would otherwise
  litter the first repo's `claude --resume` history; the current single session already
  did, so this is an unconditional improvement.
- **Trust-prompt self-heal:** the first-ever session in that new dir boots into claude's
  trust prompt, which swallows the `/usage` keystrokes (the Enter accepts the prompt —
  our own empty dir, safe). Verified live: pass 1 in a fresh dir parses empty, pass 2
  parses fully. `refresh()` therefore retries once when the readout comes back empty —
  covering the trust prompt and any transient flake.

## Fable readout

`/usage` renders a `Current week (Fable)` section (verified live: `71% used`, resets
with the weekly boundary). Changes:

- `usage-parse.ts`: `UsageReadout` gains `fablePct: number | null` and
  `fableReset: string | null`, extracted from a `sectionAfter(/current\s*week\s*\(\s*fable\s*\)/i)`
  window like the other sections; both null when the section is absent (other plans/
  machines). The reset regexes loosen `resets` → `rese?ts`: TUI cell-positioned redraws
  sometimes strip to "Rests"/"Amerca" in that screen region (observed in the real
  capture), and the loosened anchor still never collides with other words in the view.
- `usage-widget.ts`: a `Fable N% left` span follows the week label in the top line
  (hidden when null); the popover gains a `Week (Fable)` row, shown only when parsed.
  Battery fill stays session-based.

## Testing

- Parser: extend the spaced fixture with a Fable line; add a fixture derived from the
  REAL stripped capture (including the mangled `Rests …(Amerca/New_York)` artifact) —
  asserts fable 71 / week 54 / session 79 stay unconfused; null-case objects gain the
  two new fields.
- Probe/widget/cwd are session/DOM-bound (no unit-test harness, as before): gate is
  typecheck + suite green; the fresh-session behavior was validated by the experiment
  (a brand-new process fetches values on boot — the first pass proved it).
- Nothing launches the app.

## Non-goals

- No caching/deduping of refreshes; no spinner redesign (⟳ already shows … while busy).
- No per-model breakdown beyond Fable (add more sections the same way if the CLI grows
  them).
