// A harness that mounts the REAL TerminalsGrid with no DOM library and no Electron: just enough of
// the dom-shim surface and of `window` / `document` for mount() to run, a sessions file of journal
// records (they restore without git, a pty or xterm), and a serializer that turns what the grid drew
// into text. Two mounts that serialize equal drew the same thing — controls bar, layout selector,
// coordination board and every tile's placement on the stage.
//
// It exists for the Tree Stage's off-state test (tests/tree-stage-off.test.ts): `v2.treeStage` off
// must give back today's grid WHOLE, and the golden that test compares against was recorded from
// this harness before the tree stage existed. The model is tests/project-panel-render.ts.
//
// Nothing here runs a timer. Intervals and timeouts are recorded and never fire; animation frames
// are queued and run only by `flushFrames()`. So a drawing depends on what the test did, not on when
// the machine got round to it.
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir } from './temp-dir';
import type { GridDeps, SessionRecord } from '../src/terminals/terminals-grid';

type Handler = (e: unknown) => void;

export class GridEl {
	children: GridEl[] = [];
	parent: GridEl | null = null;
	className = '';
	textContent = '';
	attrs = new Map<string, string>();
	style: Record<string, string> = {};
	value = '';
	disabled = false;
	spellcheck = true;
	type = '';
	placeholder = '';
	scrollTop = 0;
	clientWidth = 0;
	clientHeight = 0;
	offsetHeight = 0;
	private handlers = new Map<string, Handler[]>();
	constructor(public tag: string) {
		// `el.style.display = …` and friends: a plain record is enough, but the serializer drops
		// empty-string values so `style.x = ''` reads as "unset", the way a browser treats it.
	}
	get classList(): { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean; toggle: (c: string, on?: boolean) => void } {
		return {
			add: (c) => { this.toggleClass(c, true); },
			remove: (c) => { this.toggleClass(c, false); },
			contains: (c) => this.has(c),
			toggle: (c, on) => { this.toggleClass(c, on); },
		};
	}
	get title(): string { return this.attrs.get('title') ?? ''; }
	set title(v: string) { this.attrs.set('title', v); }
	createEl(tag: string, o?: { cls?: string; text?: string; value?: string; type?: string; placeholder?: string; attr?: Record<string, string> } | string): GridEl {
		const c = new GridEl(tag);
		const opts = typeof o === 'string' ? { cls: o } : o;
		if (opts?.cls) c.className = opts.cls;
		if (opts?.text !== undefined) c.textContent = opts.text;
		if (opts?.value !== undefined) c.value = opts.value;
		if (opts?.type) c.type = opts.type;
		if (opts?.placeholder) c.placeholder = opts.placeholder;
		for (const [k, v] of Object.entries(opts?.attr ?? {})) c.attrs.set(k, v);
		// A <select>'s value is its first option's until something sets it, as in a browser.
		if (tag === 'option' && this.tag === 'select' && this.children.every((x) => x.tag !== 'option')) this.value = c.value;
		this.appendChild(c);
		return c;
	}
	createDiv(o?: { cls?: string; text?: string; attr?: Record<string, string> } | string): GridEl { return this.createEl('div', o); }
	createSpan(o?: { cls?: string; text?: string; attr?: Record<string, string> } | string): GridEl { return this.createEl('span', o); }
	appendChild(c: GridEl): GridEl {
		if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
		c.parent = this;
		this.children.push(c);
		return c;
	}
	setText(t: string): GridEl { this.textContent = t; return this; }
	setAttr(k: string, v: string): GridEl { this.attrs.set(k, v); return this; }
	setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
	getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
	removeAttribute(k: string): void { this.attrs.delete(k); }
	toggleClass(c: string, on?: boolean): GridEl {
		const set = new Set(this.className.split(' ').filter(Boolean));
		if (on ?? !set.has(c)) set.add(c); else set.delete(c);
		this.className = [...set].join(' ');
		return this;
	}
	addClass(...cs: string[]): GridEl { for (const c of cs) this.toggleClass(c, true); return this; }
	removeClass(...cs: string[]): GridEl { for (const c of cs) this.toggleClass(c, false); return this; }
	empty(): GridEl { for (const c of this.children) c.parent = null; this.children = []; return this; }
	remove(): void { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
	contains(o: unknown): boolean { return this.all().includes(o as GridEl); }
	querySelector(): null { return null; }
	focus(): void { fakeDocument.activeElement = this; }
	blur(): void { if (fakeDocument.activeElement === this) fakeDocument.activeElement = null; }
	scrollIntoView(): void { /* nothing to scroll */ }
	getBoundingClientRect(): { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number } {
		return { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight };
	}
	addEventListener(ev: string, fn: Handler): void {
		const l = this.handlers.get(ev) ?? [];
		l.push(fn);
		this.handlers.set(ev, l);
	}
	removeEventListener(ev: string, fn: Handler): void { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((f) => f !== fn)); }
	dispatch(ev: string, e: Record<string, unknown> = {}): void {
		const evt = { stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {}, target: this, ...e };
		for (const fn of this.handlers.get(ev) ?? []) fn(evt);
	}
	click(): void { this.dispatch('click'); }
	all(): GridEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
	text(): string { return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(' '); }
	find(pred: (e: GridEl) => boolean): GridEl | undefined { return this.all().find(pred); }
	findAll(pred: (e: GridEl) => boolean): GridEl[] { return this.all().filter(pred); }
	has(cls: string): boolean { return this.className.split(' ').includes(cls); }
}

/** The drawn tree as text, one element per line, indented by depth: tag, class, attributes (sorted),
 *  inline style (set keys only, sorted), a select's value, and text. */
export function serialize(e: GridEl, depth = 0): string {
	const attrs = [...e.attrs].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
	const styleKeys = Object.keys(e.style).filter((k) => e.style[k] !== '' && e.style[k] !== undefined).sort();
	const style = styleKeys.length ? ` style=${JSON.stringify(Object.fromEntries(styleKeys.map((k) => [k, e.style[k]])))}` : '';
	const value = e.tag === 'select' || e.tag === 'option' ? ` value=${JSON.stringify(e.value)}` : '';
	const text = e.textContent ? ` ${JSON.stringify(e.textContent)}` : '';
	const line = `${'  '.repeat(depth)}<${e.tag}${e.className ? `.${e.className.split(' ').join('.')}` : ''}${attrs}${style}${value}>${text}`;
	return [line, ...e.children.map((c) => serialize(c, depth + 1))].join('\n');
}

// ---- The globals mount() reaches for. Installed once per test file, reset per harness.

type KeyHandler = (e: KeyboardEvent) => void;
const docHandlers = new Map<string, KeyHandler[]>();
const winHandlers = new Map<string, Array<() => void>>();
let frames: Array<() => void> = [];

export const fakeDocument = {
	activeElement: null as GridEl | null,
	addEventListener(ev: string, fn: KeyHandler): void { docHandlers.set(ev, [...(docHandlers.get(ev) ?? []), fn]); },
	removeEventListener(ev: string, fn: KeyHandler): void { docHandlers.set(ev, (docHandlers.get(ev) ?? []).filter((f) => f !== fn)); },
	createElement(tag: string): GridEl { return new GridEl(tag); },
};

let nextTimer = 1;
const fakeWindow = {
	setInterval: (): number => nextTimer++,
	clearInterval: (): void => {},
	setTimeout: (): number => nextTimer++,
	clearTimeout: (): void => {},
	requestAnimationFrame: (fn: () => void): number => { frames.push(fn); return nextTimer++; },
	cancelAnimationFrame: (): void => {},
	addEventListener: (ev: string, fn: () => void): void => { winHandlers.set(ev, [...(winHandlers.get(ev) ?? []), fn]); },
	removeEventListener: (ev: string, fn: () => void): void => { winHandlers.set(ev, (winHandlers.get(ev) ?? []).filter((f) => f !== fn)); },
	wcc: { getConfig: async () => ({}), setConfig: async () => {} },
};

class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }

export function installGridGlobals(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = fakeWindow;
	g.document = fakeDocument;
	g.ResizeObserver = FakeResizeObserver;
	docHandlers.clear();
	winHandlers.clear();
	frames = [];
	fakeDocument.activeElement = null;
}

/** Run every queued animation frame (scheduleLayout coalesces into one). */
export function flushFrames(): void {
	const f = frames; frames = [];
	for (const fn of f) fn();
}

/** A keydown on the document, the way the grid's capture-phase listener sees it. Returns whether
 *  any listener called preventDefault — i.e. whether something claimed the key. */
export function pressKey(o: { key: string; code?: string; altKey?: boolean; repeat?: boolean }): boolean {
	let prevented = false;
	const e = { key: o.key, code: o.code ?? '', altKey: o.altKey ?? false, repeat: o.repeat ?? false, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => { prevented = true; }, stopPropagation() {} } as unknown as KeyboardEvent;
	for (const fn of docHandlers.get('keydown') ?? []) fn(e);
	return prevented;
}

export function keyListenerCount(): number { return (docHandlers.get('keydown') ?? []).length; }

/** Every listener the grid has left on the fake document and window, by event — empty once a grid
 *  has been disposed. */
export function listenersLeft(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [ev, l] of docHandlers) if (l.length) out[`document:${ev}`] = l.length;
	for (const [ev, l] of winHandlers) if (l.length) out[`window:${ev}`] = l.length;
	return out;
}

// ---- A grid over a temp coordination directory and a sessions file of journal records.

export interface GridHarness {
	host: GridEl;
	grid: import('../src/terminals/terminals-grid').TerminalsGrid;
	root: string;
	toasts: string[];
	/** Wait for the grid's queued writes, dispose it, check it left nothing listening, then delete
	 *  its directory. Throws if a listener survived — a teardown that leaks must fail loudly, not
	 *  perturb the next test. */
	cleanup: () => Promise<void>;
}

/** Journal records for workspace `group`, in the order they restore (tile ids 1, 2, 3…). */
export function journalRecords(names: string[], hidden: string[] = []): SessionRecord[] {
	return names.map((name) => ({ worktreePath: '', branch: '', repoName: '', repoPath: '', baseBranch: '', name, kind: 'journal' as const, ...(hidden.includes(name) ? { hidden: true } : {}) }));
}

/** Mount the real grid into a fake host. `extra` is merged into its deps (the tree stage's setting
 *  goes in here). The stage's size is fixed by `stage` and applied before the first layout. */
export async function mountGrid(o: { records?: SessionRecord[]; extra?: Partial<GridDeps>; stage?: { w: number; h: number } } = {}): Promise<GridHarness> {
	installGridGlobals();
	await trackScans();
	const { TerminalsGrid } = await import('../src/terminals/terminals-grid');
	const root = makeTempDir('cos-grid-harness-');
	const coordDir = path.join(root, 'coord', 'g1');
	fs.mkdirSync(coordDir, { recursive: true });
	const sessionsFile = path.join(root, '.terminal-sessions.json');
	fs.writeFileSync(sessionsFile, JSON.stringify({ g1: o.records ?? [] }), 'utf8');
	const toasts: string[] = [];
	const grid = new TerminalsGrid({
		repos: [],
		coordDir,
		sidecarPath: path.join(root, 'sidecar', 'sidecar.cjs'),
		notifyScriptPath: path.join(root, 'sidecar', 'notify-ready.cjs'),
		coordHookPath: path.join(root, 'sidecar', 'coord-hook.cjs'),
		sessionsFile,
		group: 'g1',
		bypassPermissions: true,
		recordLineage: true,
		toast: (m) => { toasts.push(m); },
		promptForTopic: async () => null,
		openSettings: () => {},
		...o.extra,
	});
	const host = new GridEl('div');
	// The stage is created inside mount(); give it its size the moment it exists, before restore
	// lays anything out, by sizing every div created under the host until mount returns.
	const size = o.stage ?? { w: 1600, h: 900 };
	const origCreate = GridEl.prototype.createDiv;
	GridEl.prototype.createDiv = function (this: GridEl, opts?: { cls?: string } | string) {
		const d = origCreate.call(this, opts as never);
		if (d.has('cos-terminals-stage')) { d.clientWidth = size.w; d.clientHeight = size.h; }
		return d;
	};
	try {
		await grid.mount(host as unknown as HTMLElement);
	} finally {
		GridEl.prototype.createDiv = origCreate;
	}
	flushFrames();
	return {
		host, grid, root, toasts,
		cleanup: async () => {
			// The grid's session-file writes are fire-and-forget (`void this.persist()`) on ONE chain
			// shared by every grid (TerminalsGrid.persistChain is static). Drain it before deleting the
			// directory those writes land in: otherwise a write still in flight makes Node 20's rmSync
			// fail with ENOTEMPTY, or lands in the next test's run.
			await settleGrid();
			// dispose(), not unmount(). unmount() is a workspace switch: by design it leaves the grid's
			// fs watchers on its coordination directory armed (the god outbox, connectors/, the
			// session channel), because a workspace that is not on screen must still drain its
			// requests. Deleting a directory under a live watcher makes the watcher emit EPERM on
			// Windows under Node 20, and with no 'error' listener that is an uncaught exception which
			// vitest pins on whatever test is running when it lands (PR #8, run 46065012630).
			grid.dispose();
			await settleGrid(); // dispose() kills tiles; a journal with unsaved text writes once more
			const left = listenersLeft();
			// Reset the fake globals whatever was left, so one leaking test cannot bleed into the next.
			installGridGlobals();
			try { fs.rmSync(root, { recursive: true, force: true }); }
			catch (e) {
				// Name whatever was still being written, so the next late writer is found, not guessed at.
				const what = (dir: string): string[] => { try { return fs.readdirSync(dir, { recursive: true }).map(String); } catch { return []; } };
				throw new Error(`${(e as Error).message} — still in it: ${JSON.stringify(what(root))}`);
			}
			if (Object.keys(left).length) throw new Error(`grid left listeners after dispose: ${JSON.stringify(left)}`);
		},
	};
}

/** Async work the grid starts and does not await, which writes into its directories: mount()'s
 *  `void this.scanWorktrees()` (the worktrees.md ledger). Wrapped once on the prototype so every
 *  scan any grid starts is recorded, and a teardown can wait for it instead of racing it. */
const inFlight = new Set<Promise<unknown>>();
let scansTracked = false;
async function trackScans(): Promise<void> {
	if (scansTracked) return;
	scansTracked = true;
	const { TerminalsGrid } = await import('../src/terminals/terminals-grid');
	const proto = TerminalsGrid.prototype as unknown as { scanWorktrees: (...a: unknown[]) => Promise<void> };
	const real = proto.scanWorktrees;
	proto.scanWorktrees = function (this: unknown, ...a: unknown[]) {
		const p = real.apply(this, a);
		inFlight.add(p);
		void p.finally(() => inFlight.delete(p)).catch(() => {});
		return p;
	};
}

/** Wait for every untracked write this harness knows of: scans, then the persist chain. */
export async function settleGrid(): Promise<void> {
	while (inFlight.size) await Promise.allSettled([...inFlight]);
	await settlePersists();
}

/** Resolve once every queued session-file write, from any grid, has finished. */
export async function settlePersists(): Promise<void> {
	const { TerminalsGrid } = await import('../src/terminals/terminals-grid');
	const holder = TerminalsGrid as unknown as { persistChain: Promise<void> };
	// A write can queue another behind it; wait until the chain stops moving.
	for (let last: Promise<void> | null = null; last !== holder.persistChain;) { last = holder.persistChain; await last; }
}

/** The stage element (where tiles and, with the tree stage on, the tree and slots are drawn). */
export function stageOf(h: GridHarness): GridEl {
	return h.host.find((e) => e.has('cos-terminals-stage'))!;
}

/** The toolbar's layout selector: the one <select> whose options are the tile arrangements. */
export function layoutSelectOf(h: GridHarness): GridEl | undefined {
	return h.host.find((e) => e.tag === 'select' && e.children.some((c) => c.value === 'auto'));
}
