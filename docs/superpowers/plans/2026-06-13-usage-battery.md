---
status: stable
---

# Usage Battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual-refresh "battery" in the topbar showing current-session % + reset and weekly % + reset, scraped from Claude's `/usage`.

**Architecture:** A pure `parseUsage` extracts numbers from `/usage` text; a `UsageProbe` drives a lazy, reused hidden `claude` session (via `SessionBridge`) to produce that text on demand; a `UsageWidget` renders the battery in the topbar and refreshes only on a ⟳ click.

**Tech Stack:** TypeScript, Electron renderer, node-pty (via the sidecar/`SessionBridge`), vitest.

Spec: `docs/superpowers/specs/2026-06-13-usage-battery-design.md`

---

## File Structure

- **Create** `src/terminals/usage-parse.ts` — pure `parseUsage(text)` + `stripAnsi` (no IO). Tested.
- **Create** `src/terminals/usage-probe.ts` — `UsageProbe`: drives the hidden `claude` session, returns a `UsageReadout`.
- **Create** `src/ui/usage-widget.ts` — `UsageWidget`: topbar battery + ⟳ + labels.
- **Create** `tests/usage-parse.test.ts`.
- **Modify** `src/app.ts` — mount the widget + construct the probe.
- **Modify** `app.css` — battery styling.

---

## Task 1: `parseUsage` (pure)

**Files:**
- Create: `src/terminals/usage-parse.ts`
- Test: `tests/usage-parse.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/usage-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseUsage } from '../src/terminals/usage-parse';

// Spaced form, close to how /usage renders.
const SPACED = [
  'Current session  ██████▍ 28% used   Resets 3:50am (America/New_York)',
  'Current week (all models)  ███ 6% used   Resets Jun 15, 12am (America/New_York)',
  'Current week (Sonnet only) ▌ 1% used  Resets Jun 14, 11:59pm (America/New_York)',
].join('\n');

// Collapsed form, like a stripped TUI buffer where spacing escapes were removed.
const COLLAPSED =
  'Currentsession██▍28%usedResets3:50am(America/New_York)Currentweek(allmodels)███6%usedResetsJun15,12am(America/New_York)Currentweek(Sonetnly)▌1%usedResetsJun14';

describe('parseUsage', () => {
  it('extracts session + weekly from the spaced form', () => {
    const r = parseUsage(SPACED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am (America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun 15, 12am (America/New_York)');
  });
  it('is tolerant of collapsed spacing', () => {
    const r = parseUsage(COLLAPSED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am(America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun15,12am(America/New_York)');
  });
  it('does not confuse the Sonnet-only week with the all-models week', () => {
    expect(parseUsage(SPACED).weekPct).toBe(6); // not 1
  });
  it('returns nulls for junk, never throws', () => {
    const r = parseUsage('nothing useful here');
    expect(r).toEqual({ sessionPct: null, sessionReset: null, weekPct: null, weekReset: null });
    expect(parseUsage('')).toEqual({ sessionPct: null, sessionReset: null, weekPct: null, weekReset: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/usage-parse.test.ts`
Expected: FAIL — cannot find module `../src/terminals/usage-parse`.

- [ ] **Step 3: Implement**

`src/terminals/usage-parse.ts`:

```ts
/** Pure parsing of Claude's `/usage` view — no IO, so it unit-tests cleanly. */

export interface UsageReadout {
	sessionPct: number | null;   // current session (the 5-hour window)
	sessionReset: string | null; // e.g. "3:50am (America/New_York)"
	weekPct: number | null;      // current week, all models
	weekReset: string | null;    // e.g. "Jun 15, 12am (America/New_York)"
}

/** Strip ANSI/OSC escape sequences so word/number anchors survive. Box-drawing glyphs
 *  (█ ▌ ▍) are left as-is — the field regexes skip over them. */
export function stripAnsi(text: string): string {
	return String(text)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (e.g. window title)
		.replace(/\x1b[\[\]][0-9;?]*[ -/]*[@-~]/g, '')     // CSI
		.replace(/\x1b[()][AB0]/g, '');                    // charset selects
}

/** A window of text starting at a section label, so one section's numbers don't leak in
 *  from another. */
function sectionAfter(text: string, labelRe: RegExp): string {
	const m = labelRe.exec(text);
	return m ? text.slice(m.index, m.index + 200) : '';
}

function pctIn(s: string): number | null {
	const m = /(\d{1,3})\s*%\s*used/i.exec(s);
	return m ? Math.min(100, parseInt(m[1], 10)) : null;
}

function resetIn(s: string): string | null {
	// Prefer "Resets <…>(timezone)"; fall back to a short run after "Resets".
	const m = /resets\s*([^\n]*?\([^)]+\))/i.exec(s);
	if (m) return m[1].replace(/\s+/g, ' ').trim();
	const m2 = /resets\s*([^\n]{1,40})/i.exec(s);
	return m2 ? m2[1].replace(/\s+/g, ' ').trim() : null;
}

export function parseUsage(text: string): UsageReadout {
	const t = stripAnsi(text);
	const sess = sectionAfter(t, /current\s*session/i);
	const week = sectionAfter(t, /current\s*week\s*\(?\s*all\s*models\)?/i);
	return {
		sessionPct: pctIn(sess),
		sessionReset: resetIn(sess),
		weekPct: pctIn(week),
		weekReset: resetIn(week),
	};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/usage-parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/terminals/usage-parse.ts tests/usage-parse.test.ts
git commit -m "feat(usage): parseUsage — extract session/weekly % + reset from /usage text"
```

---

## Task 2: `UsageProbe`

**Files:**
- Create: `src/terminals/usage-probe.ts`

I/O component (no unit test); verified by build + manual run. Reuses `SessionBridge`
(constructor `(sidecarPath, cwd, command, args, env)`, methods `onData/onExit/onReady/start/write/kill`).

- [ ] **Step 1: Implement**

`src/terminals/usage-probe.ts`:

```ts
import { SessionBridge } from './session-bridge';
import { parseUsage, stripAnsi, type UsageReadout } from './usage-parse';

export interface UsageProbeOpts { sidecarPath: string; cwd: string; }

/** Drives a hidden, reused `claude` session to read `/usage` on demand. `/usage` is a local
 *  command — this consumes no tokens. No worktree, no UI. */
export class UsageProbe {
	private bridge: SessionBridge | null = null;
	private buf = '';
	private ready = false;

	constructor(private opts: UsageProbeOpts) {}

	private ensureSession(): Promise<void> {
		if (this.bridge && this.ready) return Promise.resolve();
		if (!this.bridge) {
			const b = new SessionBridge(this.opts.sidecarPath, this.opts.cwd, 'claude', [], {});
			this.bridge = b;
			b.onData((d) => { this.buf += d; });
			b.onExit(() => { this.bridge = null; this.ready = false; });
			b.onReady(() => { this.ready = true; });
			b.start();
		}
		// Resolve on first ready, or after a boot timeout (claude takes a few seconds).
		return new Promise((resolve) => {
			const started = Date.now();
			const iv = window.setInterval(() => {
				if (this.ready || Date.now() - started > 9000) { window.clearInterval(iv); resolve(); }
			}, 200);
		});
	}

	/** Refresh: open /usage, wait for the scan to settle, scrape, Esc out, return the readout. */
	async refresh(): Promise<UsageReadout> {
		await this.ensureSession();
		const b = this.bridge;
		if (!b) throw new Error('usage probe: session unavailable');
		this.buf = '';
		b.write('/usage\r');
		const readout = await new Promise<UsageReadout>((resolve) => {
			const started = Date.now();
			const iv = window.setInterval(() => {
				const r = parseUsage(this.buf);
				const tail = stripAnsi(this.buf).slice(-200);
				const settled = r.sessionPct !== null && r.sessionReset !== null && !/scanning|refreshing/i.test(tail);
				if (settled || Date.now() - started > 12000) {
					window.clearInterval(iv);
					resolve(parseUsage(this.buf));
				}
			}, 400);
		});
		b.write('\x1b'); // leave the usage view so the session is reusable
		return readout;
	}

	dispose(): void { this.bridge?.kill(); this.bridge = null; this.ready = false; }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors from `usage-probe.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/terminals/usage-probe.ts
git commit -m "feat(usage): UsageProbe — lazy reused hidden claude session driving /usage"
```

---

## Task 3: `UsageWidget`

**Files:**
- Create: `src/ui/usage-widget.ts`

- [ ] **Step 1: Implement**

`src/ui/usage-widget.ts`:

```ts
import { UsageProbe } from '../terminals/usage-probe';

/** Topbar battery: session % + reset and weekly % + reset, refreshed only on ⟳. */
export class UsageWidget {
	private battFill: HTMLElement | null = null;
	private sessionLabel: HTMLElement | null = null;
	private weekLabel: HTMLElement | null = null;
	private refreshBtn: HTMLButtonElement | null = null;
	private busy = false;

	constructor(private probe: UsageProbe) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-usage' });
		const batt = el.createDiv({ cls: 'wcc-batt', attr: { title: 'Current session (5-hour window). Approximate · this machine only.' } });
		this.battFill = batt.createDiv({ cls: 'wcc-batt-fill' });
		this.sessionLabel = el.createSpan({ cls: 'wcc-usage-session', text: 'tap ⟳ for usage' });
		this.weekLabel = el.createSpan({ cls: 'wcc-usage-week', text: '' });
		this.refreshBtn = el.createEl('button', { cls: 'wcc-usage-refresh', text: '⟳', attr: { title: 'Refresh usage' } });
		this.refreshBtn.addEventListener('click', () => void this.refresh());
	}

	private async refresh(): Promise<void> {
		if (this.busy || !this.refreshBtn) return;
		this.busy = true;
		this.refreshBtn.textContent = '…';
		this.refreshBtn.disabled = true;
		try {
			const r = await this.probe.refresh();
			const pct = r.sessionPct ?? 0;
			if (this.battFill) {
				this.battFill.style.width = `${pct}%`;
				this.battFill.dataset.level = pct <= 60 ? 'ok' : pct <= 85 ? 'warn' : 'crit';
			}
			this.sessionLabel!.textContent = r.sessionPct === null
				? 'usage unavailable'
				: `${r.sessionPct}%${r.sessionReset ? ` · resets ${r.sessionReset}` : ''}`;
			this.weekLabel!.textContent = r.weekPct === null
				? ''
				: `Week ${r.weekPct}%${r.weekReset ? ` · ${r.weekReset}` : ''}`;
		} catch {
			this.sessionLabel!.textContent = "couldn't read usage — try again";
		} finally {
			this.busy = false;
			this.refreshBtn.textContent = '⟳';
			this.refreshBtn.disabled = false;
		}
	}
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors from `usage-widget.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/ui/usage-widget.ts
git commit -m "feat(usage): UsageWidget — topbar battery + manual refresh"
```

---

## Task 4: Wire into the topbar + styling

**Files:**
- Modify: `src/app.ts`
- Modify: `app.css`

- [ ] **Step 1: Mount in `src/app.ts`**

Add imports near the top:

```ts
import { UsageProbe } from './terminals/usage-probe';
import { UsageWidget } from './ui/usage-widget';
```

After the `statusSpan` line (`const statusSpan = topBar.createSpan(...)`), add:

```ts
			const usageProbe = new UsageProbe({
				sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
				cwd: repos[0]?.path ?? userData,
			});
			new UsageWidget(usageProbe).render(topBar);
			window.addEventListener('beforeunload', () => usageProbe.dispose());
```

- [ ] **Step 2: Style in `app.css`** (append)

```css
/* Usage battery in the topbar. */
.wcc-usage { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; color: var(--text-muted); }
.wcc-batt { position: relative; width: 46px; height: 16px; border: 1px solid var(--text-muted); border-radius: 3px; padding: 1px; box-sizing: border-box; }
.wcc-batt::after { content: ''; position: absolute; right: -4px; top: 4px; width: 3px; height: 6px; background: var(--text-muted); border-radius: 0 2px 2px 0; }
.wcc-batt-fill { height: 100%; width: 0%; border-radius: 2px; background: #2fae6e; transition: width .3s ease; }
.wcc-batt-fill[data-level='warn'] { background: #e0a92e; }
.wcc-batt-fill[data-level='crit'] { background: #d2453e; }
.wcc-usage-session { color: var(--text-normal); }
.wcc-usage-week { opacity: .8; }
.wcc-usage-refresh { background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; }
.wcc-usage-refresh:hover { color: var(--text-normal); }
.wcc-usage-refresh:disabled { opacity: .5; cursor: default; }
```

Note: `.wcc-usage { margin-left: auto }` pushes the battery to the right end of the topbar. If the
topbar isn't a flexbox, also ensure `.wcc-topbar { display: flex; align-items: center; }` (it
already is per app.css).

- [ ] **Step 3: Build + full test**

Run: `npm run build && npm test`
Expected: tsc + esbuild clean; all tests pass (incl. `usage-parse`).

- [ ] **Step 4: Commit**

```bash
git add src/app.ts app.css
git commit -m "feat(usage): mount the usage battery in the topbar"
```

- [ ] **Step 5: Manual verification (`npm start`)**

- Topbar shows an empty battery + "tap ⟳ for usage".
- Click ⟳ → "…" spinner → after a few seconds the battery fills to your session %, label reads e.g. `28% · resets 3:50am (America/New_York)`, and `Week 6% · Jun 15 …`.
- Cross-check the numbers against `/usage` typed in a real terminal — they should match.
- Click ⟳ again → faster (session reused).

---

## Self-Review

- **Spec coverage:** §4.1 parser → Task 1. §4.2 probe (lazy+reused, settle-poll, Esc-out) → Task 2. §4.3 widget (battery, ⟳, labels, states) → Task 3. §4.4 wiring → Task 4. §5 visual → Task 3 + Task 4 CSS. §6 risks (tolerant parse → nulls → "unavailable"; trusted-repo cwd; settle cap; dispose) → Tasks 1,2,4. §7 tests → Task 1 + Task 4 manual.
- **Type consistency:** `UsageReadout` defined in Task 1, consumed by `UsageProbe.refresh()` (Task 2) and `UsageWidget.refresh()` (Task 3). `stripAnsi`/`parseUsage` exported from `usage-parse` and imported by the probe. `UsageProbe` constructor `{ sidecarPath, cwd }` matches the call in Task 4. `SessionBridge` ctor/methods match `session-bridge.ts`.
- **Placeholder scan:** none — all code is concrete.
- **Note:** `createDiv`/`createSpan`/`createEl` + `dataset`/`style` are the existing dom-shim helpers used across `src/ui` and `src/terminals`.
