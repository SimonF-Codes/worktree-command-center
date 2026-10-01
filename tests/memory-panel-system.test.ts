import { describe, it, expect } from 'vitest';
import { MemoryMonitor } from '../src/terminals/memory-monitor';
import { ServiceCache } from '../src/terminals/service-snapshot';
import { MemoryPanel, PANEL_POLL_MS } from '../src/ui/memory-panel';
import { WIDGET_POLL_MS } from '../src/ui/memory-widget';
import type { ProcRow } from '../src/terminals/process-snapshot';
import type { ServiceSnapshot } from '../src/terminals/system-memory';

/** Just enough of the dom-shim surface for the panel to render into, with no DOM library: the
 *  point is to drive the REAL MemoryPanel, so the poller assertions are about the shipped panel
 *  rather than a stand-in for it. */
class FakeEl {
	children: FakeEl[] = [];
	parent: FakeEl | null = null;
	className = '';
	textContent = '';
	value = '';
	selected = false;
	attrs = new Map<string, string>();
	private handlers = new Map<string, Array<(e: unknown) => void>>();
	constructor(public tag: string) {}
	createEl(tag: string, o?: { cls?: string; text?: string; value?: string; attr?: Record<string, string> }): FakeEl {
		const c = new FakeEl(tag);
		if (o?.cls) c.className = o.cls;
		if (o?.text !== undefined) c.textContent = o.text;
		if (o?.value !== undefined) c.value = o.value;
		for (const [k, v] of Object.entries(o?.attr ?? {})) c.attrs.set(k, v);
		c.parent = this;
		this.children.push(c);
		return c;
	}
	createDiv(o?: { cls?: string; text?: string }): FakeEl { return this.createEl('div', o); }
	createSpan(o?: { cls?: string; text?: string }): FakeEl { return this.createEl('span', o); }
	empty(): void { this.children = []; }
	remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
	addEventListener(ev: string, fn: (e: unknown) => void): void {
		const l = this.handlers.get(ev) ?? [];
		l.push(fn);
		this.handlers.set(ev, l);
	}
	click(): void { for (const fn of this.handlers.get('click') ?? []) fn({ stopPropagation() {} }); }
	all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
	text(): string { return [this.textContent, ...this.children.map((c) => c.text())].join(' '); }
	find(pred: (e: FakeEl) => boolean): FakeEl | undefined { return this.all().find(pred); }
}

const MB = 1024 * 1024;
const APP = 101;
const rows: ProcRow[] = [
	{ pid: 20, ppid: 4, name: 'explorer.exe', rssBytes: 200 * MB },
	{ pid: 100, ppid: 20, name: 'Worktree Command Center.exe', rssBytes: 150 * MB },
	{ pid: APP, ppid: 100, name: 'Worktree Command Center.exe', rssBytes: 300 * MB },
	{ pid: 5, ppid: 4, name: 'Memory Compression', rssBytes: 1471 * MB },
	{ pid: 600, ppid: 11, name: 'svchost.exe', rssBytes: 92 * MB },
	{ pid: 601, ppid: 11, name: 'svchost.exe', rssBytes: 12 * MB },
	{ pid: 301, ppid: 9999, name: 'claude.exe', rssBytes: 344 * MB },
];
const services: ServiceSnapshot = {
	services: [{ name: 'DPS', displayName: 'Diagnostic Policy Service', pid: 600, pathName: 'svchost.exe -k LocalServiceNoNetwork -p' }],
	wslDistros: [],
};

function build() {
	const live = new Map<number, number>();
	let next = 1;
	let processSnapshots = 0;
	let serviceQueries = 0;
	const monitor = new MemoryMonitor({
		appPid: APP,
		claims: () => [],
		snapshot: async () => { processSnapshots++; return rows; },
		setInterval: (_fn, ms) => { const h = next++; live.set(h, ms); return h; },
		clearInterval: (h) => { live.delete(h); },
	});
	const cache = new ServiceCache(async () => { serviceQueries++; return services; }, () => 0);
	const panel = new MemoryPanel({
		monitor,
		endSession: async () => true,
		toast: () => {},
		totalRamBytes: 32 * 1024 * MB,
		freeRamBytes: () => 13 * 1024 * MB,
		services: cache,
	});
	const parent = new FakeEl('div');
	return {
		monitor, panel, parent, cache,
		timers: () => [...live.values()],
		processSnapshots: () => processSnapshots,
		serviceQueries: () => serviceQueries,
		open: () => panel.open(parent as unknown as HTMLElement),
		tab: (v: 'sessions' | 'system') => parent.find((e) => e.attrs.get('data-view') === v)!.click(),
		body: () => parent.find((e) => e.className === 'wcc-mem-body')!,
	};
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Memory panel — Sessions and System are two views over ONE poller', () => {
	it('with the widget, the panel and BOTH views opened: exactly one timer, one snapshot per tick', async () => {
		const t = build();
		t.monitor.subscribe(WIDGET_POLL_MS, () => {}); // the always-on gauge
		t.open();
		await settle();
		t.tab('system');
		await settle();
		t.tab('sessions');
		t.tab('system');
		await settle();

		expect(t.monitor.pollerCount()).toBe(1);
		expect(t.timers()).toEqual([PANEL_POLL_MS]);
		// The panel's open measured once. Switching views — three times — measured nothing.
		expect(t.processSnapshots()).toBe(1);

		await t.monitor.refreshNow(); // a tick
		await settle();
		expect(t.processSnapshots()).toBe(2);
		expect(t.monitor.pollerCount()).toBe(1);
	});

	it('the System view renders from the monitor\'s rows — it never takes a process snapshot of its own', async () => {
		const t = build();
		t.open();
		await settle();
		const before = t.processSnapshots();
		t.tab('system');
		await settle();
		expect(t.processSnapshots()).toBe(before);
		const text = t.body().text();
		expect(text).toContain('DPS');
		expect(text).toContain('-k LocalServiceNoNetwork');
		expect(text).toContain('symptom');
		expect(text).toMatch(/1 claude\.exe process holding 344 MB belongs to neither/);
		expect(text).toContain('nothing is behind vmmem');
	});

	it('Win32_Service is asked only while the System view is showing', async () => {
		const t = build();
		t.open();
		await t.monitor.refreshNow();
		await settle();
		expect(t.serviceQueries()).toBe(0); // Sessions only: never

		t.tab('system');
		await settle();
		expect(t.serviceQueries()).toBe(1);

		t.tab('sessions');
		expect(t.cache.latest()).toBeNull(); // dropped on leaving
		await t.monitor.refreshNow();
		await settle();
		expect(t.serviceQueries()).toBe(1);

		t.tab('system');
		await settle();
		t.panel.close();
		expect(t.cache.latest()).toBeNull();
		await t.monitor.refreshNow();
		await settle();
		expect(t.serviceQueries()).toBe(2);
	});

	it('closing the panel from the System view releases the poller cadence like it always did', async () => {
		const t = build();
		t.monitor.subscribe(WIDGET_POLL_MS, () => {});
		t.open();
		t.tab('system');
		await settle();
		t.panel.close();
		expect(t.timers()).toEqual([WIDGET_POLL_MS]);
	});

	it('the System view has NO controls beyond the tabs, ⟳ and Close — services are read-only', async () => {
		const t = build();
		t.open();
		t.tab('system');
		await settle();
		expect(t.body().all().filter((e) => e.tag === 'button' || e.tag === 'select')).toEqual([]);
		const panelButtons = t.parent.all().filter((e) => e.tag === 'button').map((e) => e.textContent);
		expect(panelButtons.sort()).toEqual(['Close', 'Sessions', 'System', '⟳']);
	});

	it('the Sessions view keeps its controls exactly as before', async () => {
		const t = build();
		t.open();
		await settle();
		const labels = t.parent.all().filter((e) => e.tag === 'button').map((e) => e.textContent);
		expect(labels).toEqual(expect.arrayContaining(['⟳', 'Close all idle…', 'Close']));
		expect(t.parent.find((e) => e.tag === 'select')).toBeDefined();
		expect(t.panel.currentView()).toBe('sessions');
	});
});
