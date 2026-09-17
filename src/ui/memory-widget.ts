import * as os from 'os';
import type { MemoryMonitor } from '../terminals/memory-monitor';
import { gaugeFrom, gaugePending, type GaugeState } from '../terminals/memory-gauge';
import type { MemoryReport } from '../terminals/session-memory';

/** How fast the widget asks the shared poller to run. The panel asks for 20s on top of this
 *  while it is open; the monitor runs ONE timer at the faster of the two.
 *
 *  60s, chosen against a measurement rather than a guess. One `Win32_Process` snapshot on this
 *  machine (16 cores, ~416 processes) costs ~300 ms wall and ~280 ms of CPU — about 0.5% of a
 *  single core at this cadence, 0.03% of the machine. That is an order of magnitude more than
 *  "tens of milliseconds", so it is not free, but it is bounded and it is worth it: the leak
 *  this exists to catch grew at 3 GB/hour, and 60s sees it within a minute of it mattering. */
export const WIDGET_POLL_MS = 60_000;

/** The first measurement waits this long after render. Deferred past first paint for the same
 *  reason the stray reaper is: a snapshot costs a third of a second and a transient ~120 MB of
 *  PowerShell, and neither belongs in front of the UI at launch. */
const PRIME_DELAY_MS = 4_000;

/** The machine, read ONCE. It does not change, and re-reading it per paint would be the kind
 *  of small pointless cost this whole feature is about.
 *
 *  Free memory is the opposite: it is the fastest-moving of the three numbers on the bar, so
 *  `os.freemem()` is re-read on every paint. It reads a counter the kernel already keeps and
 *  spawns nothing, so it costs nothing against the budget this tracker is careful about — the
 *  ~300 ms `Win32_Process` query is the price of a poll, and this is not part of it. */
const TOTAL_RAM_BYTES = os.totalmem();

export interface MemoryWidgetDeps {
	/** Open the existing MemoryPanel. The widget REPLACES the old `🧠 Memory` button, so this
	 *  is the only way into the panel — two entry points to one panel is clutter. */
	onOpen: () => void;
	/** Override the denominator in tests. Defaults to this machine's physical RAM. */
	totalRamBytes?: number;
	/** Override free memory in tests. A FUNCTION, not a number, because unlike the total it is
	 *  re-read on every paint. Defaults to `os.freemem()`. */
	freeRamBytes?: () => number;
}

/** Top-bar memory gauge: `RAM ██▓▓▓▓▓▓░░░ 1.1 GB · 18.2/31 used`, beside the usage battery and
 *  mirroring its idiom — a small bar, a number, click for detail.
 *
 *  It exists because the tracker shipped as a panel behind a button, and a number you have to
 *  ask for cannot warn you. The usage-probe leak ran for hours at 3 GB/hour while the floor
 *  looked healthy, and nobody opens a memory panel on a machine that seems fine.
 *
 *  THREE SEGMENTS, because one fill answered the gauge's own question wrong. It drew the app's
 *  share and left the rest as empty track, which reads as headroom: on 2026-09-17 that was
 *  `1.1/31 GB` — a 3% bar — on a machine with 12.9 GB actually free and 17.1 GB held by other
 *  processes. The empty 97% was conflating "free" with "someone else's", and it erred in the
 *  dangerous direction, since the one question a pressure gauge exists to answer is whether
 *  there is room for another terminal. */
export class MemoryWidget {
	private el: HTMLElement | null = null;
	private fillEl: HTMLElement | null = null;
	private otherEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private primeTimer: number | null = null;

	constructor(private monitor: MemoryMonitor, private deps: MemoryWidgetDeps) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-mem-widget' });
		this.el = el;
		// A unit label, not an icon and not a button: the emoji read as decoration in a strip of
		// instrument readings, and "RAM" says what the bar beside it is measuring.
		el.createSpan({ cls: 'wcc-mem-widget-tag', text: 'RAM' });
		const bar = el.createDiv({ cls: 'wcc-membar' });
		// This app FIRST, against the bar's fixed left edge: its size is the quantity being
		// compared over time, and at 38px wide a segment that floats is unreadable. Other
		// processes follow, muted. Free is whatever is left — the unfilled track, which already
		// reads as empty without a third colour or a legend to explain it.
		this.fillEl = bar.createDiv({ cls: 'wcc-membar-fill' });
		this.otherEl = bar.createDiv({ cls: 'wcc-membar-other' });
		this.labelEl = el.createSpan({ cls: 'wcc-mem-widget-label' });
		el.addEventListener('click', (e) => { e.stopPropagation(); this.deps.onOpen(); });

		this.apply(gaugePending());
		// Live for the app's whole life: an always-on gauge is the entire point.
		this.unsubscribe = this.monitor.subscribe(WIDGET_POLL_MS, (r) => this.apply(this.gauge(r)));
		const last = this.monitor.latest();
		if (last) this.apply(this.gauge(last));
		else this.primeTimer = window.setTimeout(() => void this.monitor.refreshNow(), PRIME_DELAY_MS);
	}

	private gauge(r: MemoryReport): GaugeState {
		// Nothing measured at all — a platform with no process snapshot. Show a dash, not "0 MB",
		// which would read as a healthy floor.
		if (!r.sessions.length && !r.unattributed.procCount && !r.appSelfBytes) return gaugePending();
		const free = this.deps.freeRamBytes ? this.deps.freeRamBytes() : os.freemem();
		return gaugeFrom(r, this.deps.totalRamBytes ?? TOTAL_RAM_BYTES, free);
	}

	private apply(g: GaugeState): void {
		if (this.fillEl) this.fillEl.style.width = `${(g.split.appFrac * 100).toFixed(1)}%`;
		if (this.otherEl) this.otherEl.style.width = `${(g.split.otherFrac * 100).toFixed(1)}%`;
		if (this.labelEl) this.labelEl.textContent = g.label;
		// One attribute on the root drives the colour of both bar and label, the way the
		// battery's data-level does.
		this.el?.setAttribute('data-level', g.level);
		// A SECOND, INDEPENDENT attribute, and it tints the free segment only. data-level means
		// "this app needs attention"; if a machine full of someone else's memory could turn it
		// red, the one reading that has to be trusted would start crying wolf about things
		// nobody can fix from here.
		this.el?.setAttribute('data-pressure', g.pressure);
		this.el?.setAttribute('title', g.title);
	}

	dispose(): void {
		if (this.primeTimer !== null) { window.clearTimeout(this.primeTimer); this.primeTimer = null; }
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}
