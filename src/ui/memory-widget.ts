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
 *  of small pointless cost this whole feature is about. */
const TOTAL_RAM_BYTES = os.totalmem();

export interface MemoryWidgetDeps {
	/** Open the existing MemoryPanel. The widget REPLACES the old `🧠 Memory` button, so this
	 *  is the only way into the panel — two entry points to one panel is clutter. */
	onOpen: () => void;
	/** Override the denominator in tests. Defaults to this machine's physical RAM. */
	totalRamBytes?: number;
}

/** Top-bar memory gauge: `🧠 ▓▓▓▓░░░░ 2.3 GB · 7`, beside the usage battery and mirroring its
 *  idiom — a small bar, a number, click for detail.
 *
 *  It exists because the tracker shipped as a panel behind a button, and a number you have to
 *  ask for cannot warn you. The usage-probe leak ran for hours at 3 GB/hour while the floor
 *  looked healthy, and nobody opens a memory panel on a machine that seems fine. */
export class MemoryWidget {
	private el: HTMLElement | null = null;
	private fillEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private primeTimer: number | null = null;

	constructor(private monitor: MemoryMonitor, private deps: MemoryWidgetDeps) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-mem-widget' });
		this.el = el;
		el.createSpan({ cls: 'wcc-mem-widget-icon', text: '🧠' });
		const bar = el.createDiv({ cls: 'wcc-membar' });
		this.fillEl = bar.createDiv({ cls: 'wcc-membar-fill' });
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
		return gaugeFrom(r, this.deps.totalRamBytes ?? TOTAL_RAM_BYTES);
	}

	private apply(g: GaugeState): void {
		if (this.fillEl) this.fillEl.style.width = `${(g.fill * 100).toFixed(1)}%`;
		if (this.labelEl) this.labelEl.textContent = g.label;
		// One attribute on the root drives the colour of both bar and label, the way the
		// battery's data-level does.
		this.el?.setAttribute('data-level', g.level);
		this.el?.setAttribute('title', g.title);
	}

	dispose(): void {
		if (this.primeTimer !== null) { window.clearTimeout(this.primeTimer); this.primeTimer = null; }
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}
