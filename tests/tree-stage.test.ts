import { describe, it, expect, beforeEach } from 'vitest';
import { TreeStage, SLOT_HEAD_H, attentionOfState, type Placeable, type TreeStageHost } from '../src/terminals/tree-stage';
import { DEFAULT_CELL_METRICS } from '../src/terminals/bubble-layout';
import type { FloorSession } from '../src/core/session-requests';
import type { SlotFacts } from '../src/core/side-panel';
import type { RoleLookup } from '../src/core/delegation';
import { GridEl, installGridGlobals } from './grid-harness';

// The TreeStage controller over a fake host: real DOM-shaped elements (tests/grid-harness.ts), fake
// tiles that record every call made on them, and a floor the test edits between ticks.

class FakeTile implements Placeable {
	calls: string[] = [];
	visible = true;
	centered = false;
	rect: { x: number; y: number; w: number; h: number } | null = null;
	focused = 0;
	constructor(readonly key: number, readonly name: string, readonly branch = `wt/${key}`, readonly kind: Placeable['kind'] = 'terminal') {}
	setRect(r: { x: number; y: number; w: number; h: number }): void { this.calls.push('rect'); this.rect = r; }
	setCentered(on: boolean): void { this.calls.push(`centered:${on}`); this.centered = on; }
	setVisible(on: boolean): void { this.calls.push(`visible:${on}`); this.visible = on; }
	focus(): void { this.focused++; }
}

interface Floor {
	tiles: FakeTile[];
	sessions: FloorSession[];
	states: Map<number, { state: string; branch: string }>;
	facts: Map<number, Partial<SlotFacts>>;
	row: { stageW: number; dockW: number; stageH: number };
	now: number;
	overseerFocused: number;
	delegation?: RoleLookup;
	proposals?: Record<string, number>;
}

let floor: Floor;
let stage: GridEl;

function host(): TreeStageHost {
	return {
		stage: stage as unknown as HTMLElement,
		placeables: () => floor.tiles,
		sessions: () => floor.sessions,
		states: () => floor.states,
		isolationChip: (k) => (k > 0 ? 'wt' : null),
		delegation: () => floor.delegation,
		proposals: () => floor.proposals,
		facts: (k) => ({ draft: false, queued: false, idle: false, ...floor.facts.get(k) }),
		metrics: () => DEFAULT_CELL_METRICS,
		row: () => floor.row,
		focusOverseer: () => { floor.overseerFocused++; },
		now: () => floor.now,
	};
}

/** A floor: the overseer (−1) and workers 1..n under it, all running. */
function makeFloor(n: number, over: Partial<Floor> = {}): Floor {
	const tiles = Array.from({ length: n }, (_, i) => new FakeTile(i + 1, `w${i + 1}`));
	const sessions: FloorSession[] = [
		{ key: -1, sessionId: 'alpha', role: 'alpha', name: 'Alpha' },
		...tiles.map((t) => ({ key: t.key, sessionId: `s${t.key}`, role: 'worker-terminal', name: t.name, parentSessionId: 'alpha' })),
	];
	const states = new Map<number, { state: string; branch: string }>([[-1, { state: 'running', branch: '—' }], ...tiles.map((t) => [t.key, { state: 'running', branch: t.branch }] as [number, { state: string; branch: string }])]);
	return { tiles, sessions, states, facts: new Map(), row: { stageW: 1600, dockW: 0, stageH: 800 }, now: 1_000_000, overseerFocused: 0, ...over };
}

const nodeEl = (key: number) => stage.find((e) => e.has('cos-tree-node') && e.attrs.get('data-key') === String(key));
const slotTitle = (id: 'a' | 'b') => stage.find((e) => e.has(`cos-slot-${id}`))?.find((e) => e.has('cos-slot-title'))?.textContent;
const tile = (k: number) => floor.tiles.find((t) => t.key === k)!;

beforeEach(() => {
	installGridGlobals();
	stage = new GridEl('div');
	stage.className = 'cos-terminals-stage';
});

describe('the tree as the stage', () => {
	it('draws one node per session — the overseer included — with the sidebar row\'s fields', () => {
		floor = makeFloor(2, { proposals: { s1: 2 } });
		floor.states.set(2, { state: 'prompt', branch: 'wt/2' });
		const t = new TreeStage(host()); t.mount();
		const n1 = nodeEl(1)!;
		expect(n1.text()).toContain('w1');
		expect(n1.find((e) => e.has('cos-tree-node-l2'))!.textContent).toBe('worker-terminal · wt');
		expect(n1.find((e) => e.has('cos-tree-node-l3'))!.textContent).toBe('wt/1');
		expect(n1.find((e) => e.has('cos-tree-proposals'))!.textContent).toBe('◆2');
		expect(nodeEl(2)!.has('dot-needs')).toBe(true);
		expect(nodeEl(2)!.find((e) => e.has('cos-tree-attn'))!.textContent).toBe('⏳');
		expect(nodeEl(-1)!.text()).toContain('Alpha');
		expect(stage.findAll((e) => e.has('cos-tree-node'))).toHaveLength(3);
	});

	it('marks the overseer\'s edges unchecked, and says why on the edge', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		const edges = stage.findAll((e) => e.has('cos-tree-edge'));
		expect(edges).toHaveLength(2);
		for (const e of edges) { expect(e.has('unchecked')).toBe(true); expect(e.attrs.get('title')).toMatch(/overseer/); }
	});

	it('★ comes from buildTeam\'s role-file verdict, not from having children', () => {
		floor = makeFloor(1);
		floor.sessions[1]!.role = 'mgr';
		floor.delegation = (slug) => ({ alpha: { slug: 'alpha', authority: 'autonomous', spawns: ['mgr'] }, mgr: { slug: 'mgr', authority: 'operator', spawns: [] } } as Record<string, never>)[slug];
		const t = new TreeStage(host()); t.mount();
		expect(nodeEl(1)!.find((e) => e.has('cos-tree-manager'))).toBeUndefined();
		floor.delegation = (slug) => ({ alpha: { slug: 'alpha', authority: 'autonomous', spawns: ['mgr', 'w'] }, mgr: { slug: 'mgr', authority: 'operator', spawns: ['w'] } } as Record<string, never>)[slug];
		t.layout();
		expect(nodeEl(1)!.find((e) => e.has('cos-tree-manager'))!.textContent).toBe('★');
	});

	it('the overseer\'s node opens its dock, never a slot', () => {
		floor = makeFloor(1);
		const t = new TreeStage(host()); t.mount();
		nodeEl(-1)!.click();
		expect(floor.overseerFocused).toBe(1);
		expect(t.state.slots.A.key).toBeNull();
	});

	it('collapsing a subtree is viewer state: the node says how many it hides', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		nodeEl(-1)!.find((e) => e.has('cos-tree-toggle'))!.click();
		expect(stage.findAll((e) => e.has('cos-tree-node'))).toHaveLength(1);
		expect(nodeEl(-1)!.find((e) => e.has('cos-tree-toggle'))!.textContent).toBe('▸ 3');
	});
});

describe('placement — one place moves a tile, and a focus flip is never a resize', () => {
	it('a tile not in a slot is hidden; one in a slot is shown at the slot body', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		expect(tile(1).visible).toBe(false);
		nodeEl(1)!.click();
		expect(t.state.slots.A.key).toBe(1);
		const split = t.currentSplit!;
		expect(tile(1).visible).toBe(true);
		expect(tile(1).rect).toEqual({ x: split.treeW + 4, y: SLOT_HEAD_H, w: split.slotW - 8, h: 800 - SLOT_HEAD_H - 4 });
		expect(tile(2).visible).toBe(false);
	});

	it('focusing the other slot only flips centered: no setRect, no visibility change', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click();
		expect([t.state.slots.A.key, t.state.slots.B.key]).toEqual([1, 2]);
		t.tileClicked(1);
		tile(1).calls = []; tile(2).calls = [];
		t.tileClicked(2);
		expect(tile(1).calls).toEqual(['centered:false']);
		expect(tile(2).calls).toEqual(['centered:true']);
	});

	it('paneMode drives the cadence: focused = centered (live), the other slot visible, the rest hidden', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click(); t.tileClicked(1);
		expect([tile(1).centered, tile(1).visible]).toEqual([true, true]);
		expect([tile(2).centered, tile(2).visible]).toEqual([false, true]);
		expect([tile(3).centered, tile(3).visible]).toEqual([false, false]);
	});

	it('a click inside a tile in an unfocused slot focuses that slot and hands the tile the keyboard', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click();
		const before = tile(2).focused;
		t.tileClicked(2);
		expect(t.state.focused).toBe('B');
		expect(tile(2).focused).toBe(before + 1);
	});

	it('a repeated layout touches nothing', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click();
		tile(1).calls = [];
		t.layout(); t.layout();
		expect(tile(1).calls).toEqual([]);
	});
});

describe('the click rule, through the drawn tree', () => {
	it('opens in the slot not being read, and the reader keeps the keyboard', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); t.tileClicked(1); // reading A
		const before = tile(1).focused;
		nodeEl(2)!.click();
		expect(t.state.slots.B.key).toBe(2);
		expect(t.state.focused).toBe('A');
		expect(tile(1).focused).toBe(before + 1); // DOM focus handed back to the slot being read
		nodeEl(3)!.click(); // A still read: B is replaced, A never is
		expect([t.state.slots.A.key, t.state.slots.B.key]).toEqual([1, 3]);
	});

	it('both protected: the node is selected and its card offers Open in A / Open in B', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click(); t.tileClicked(1);
		floor.facts.set(2, { draft: true });
		nodeEl(3)!.click();
		expect([t.state.slots.A.key, t.state.slots.B.key]).toEqual([1, 2]);
		const offers = nodeEl(3)!.findAll((e) => e.has('cos-tree-offer-btn')).map((e) => e.textContent);
		expect(offers).toEqual(['Open in A', 'Open in B']);
		nodeEl(3)!.findAll((e) => e.has('cos-tree-offer-btn'))[1]!.click();
		expect([t.state.slots.A.key, t.state.slots.B.key, t.state.focused]).toEqual([1, 3, 'B']);
	});

	it('one seat: a protected slot offers Open here', () => {
		floor = makeFloor(2, { row: { stageW: 1100, dockW: 0, stageH: 800 } });
		const t = new TreeStage(host()); t.mount();
		expect(t.currentSplit!.slots).toBe(1);
		nodeEl(1)!.click(); t.tileClicked(1);
		nodeEl(2)!.click();
		expect(nodeEl(2)!.findAll((e) => e.has('cos-tree-offer-btn')).map((e) => e.textContent)).toEqual(['Open here']);
	});
});

describe('the width — the parked chip', () => {
	it('narrowing to one seat parks B as a chip, and choosing it swaps with A', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click();
		floor.row = { stageW: 1100, dockW: 0, stageH: 800 };
		t.layout();
		expect([t.state.slots.A.key, t.state.slots.B.key, t.state.parked]).toEqual([1, null, 2]);
		expect(tile(2).visible).toBe(false); // parked, not closed: hidden, still running
		const chip = stage.find((e) => e.has('cos-slot-parked'))!;
		expect(chip.textContent).toBe('parked: w2 ⇄');
		chip.click();
		expect([t.state.slots.A.key, t.state.parked]).toEqual([2, 1]);
		floor.row = { stageW: 1600, dockW: 0, stageH: 800 };
		t.layout();
		expect([t.state.slots.A.key, t.state.slots.B.key, t.state.parked]).toEqual([2, 1, null]);
	});

	it('one session: one slot, filling the stage beside a one-card tree', () => {
		floor = makeFloor(1);
		floor.sessions = floor.sessions.filter((s) => s.key !== -1).map((s) => { const { parentSessionId: _p, ...rest } = s; return rest; });
		const t = new TreeStage(host()); t.mount();
		const s = t.currentSplit!;
		expect(s.slots).toBe(1);
		expect(s.rail).toBe(false);
		expect(s.slotW).toBe(1600 - s.treeW);
		expect(stage.find((e) => e.has('cos-slot-b'))!.style.display).toBe('none');
	});

	it('too narrow for a card, the tree is a rail of state dots that still click', () => {
		floor = makeFloor(2, { row: { stageW: 2 * 570 + 40, dockW: 0, stageH: 800 } });
		const t = new TreeStage(host()); t.mount();
		expect(t.currentSplit!.rail).toBe(true);
		const dots = stage.findAll((e) => e.has('cos-tree-raildot'));
		expect(dots).toHaveLength(3);
		dots.find((d) => d.attrs.get('data-key') === '1')!.click();
		expect(t.state.slots.A.key).toBe(1);
	});
});

describe('the attention rule, on the tick', () => {
	it('a session that starts waiting gets a badge, and opens by itself only into a free slot', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		t.tick(); // seed: first sighting is silent
		floor.states.set(2, { state: 'prompt', branch: 'wt/2' });
		t.tick();
		expect(t.state.slots.A.key).toBe(2);
		expect(t.state.focused).toBeNull(); // never by moving focus
		expect(tile(2).focused).toBe(0);
		expect(nodeEl(2)!.find((e) => e.has('cos-tree-attn'))!.textContent).toBe('⏳');
	});

	it('when both slots are protected, only the badge — nothing moves and focus stays', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click(); t.tileClicked(1);
		floor.facts.set(2, { draft: true, idle: true });
		floor.now += 31_000; // past the manual hold
		t.tick();
		floor.states.set(3, { state: 'menu', branch: 'wt/3' });
		t.tick();
		expect([t.state.slots.A.key, t.state.slots.B.key, t.state.focused]).toEqual([1, 2, 'A']);
		expect(nodeEl(3)!.find((e) => e.has('cos-tree-attn'))!.textContent).toBe('⏳');
	});

	it('within 30 s of a manual choice nothing opens by itself', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		t.tick();
		nodeEl(1)!.click();
		floor.states.set(2, { state: 'idle', branch: 'wt/2' });
		t.tick();
		expect(t.state.slots.B.key).toBeNull();
		floor.now += 30_000;
		floor.states.set(3, { state: 'prompt', branch: 'wt/3' });
		t.tick();
		expect(t.state.slots.B.key).toBe(3);
	});

	it('maps the classifier states onto the attention kinds', () => {
		expect(['prompt', 'menu', 'errored', 'idle', 'running'].map(attentionOfState)).toEqual(['input', 'input', 'help', 'done', null]);
	});
});

describe('keys', () => {
	it('stepSelection moves between siblings; jumpTo runs the click rule on the i-th badge', () => {
		floor = makeFloor(3);
		const t = new TreeStage(host()); t.mount();
		t.stepSelection(1);
		expect(t.selection).toBe(-1);
		t.jumpTo(1); // badge order: Alpha, w1, w2, w3
		expect(t.state.slots.A.key).toBe(1);
		t.stepSelection(1);
		expect(t.selection).toBe(2);
	});

	it('pin, focus a slot, close a slot', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		nodeEl(1)!.click(); nodeEl(2)!.click();
		t.focusSlotKey('B');
		expect(t.state.focused).toBe('B');
		t.pinFocused();
		expect(t.state.slots.B.pinned).toBe(true);
		expect(stage.find((e) => e.has('cos-slot-b'))!.has('pinned')).toBe(true);
		t.closeFocused();
		expect([t.state.slots.B.key, t.state.focused]).toEqual([null, null]);
		expect(slotTitle('b')).toBe('B · empty');
	});

	it('badges show while Alt is held', () => {
		floor = makeFloor(2);
		const t = new TreeStage(host()); t.mount();
		t.setBadges(true);
		expect(nodeEl(-1)!.find((e) => e.has('cos-tree-badge'))!.textContent).toBe('F1');
		t.setBadges(false);
		expect(stage.find((e) => e.has('cos-tree-badge'))).toBeUndefined();
	});
});

describe('unmount', () => {
	it('removes only the tree\'s own DOM', () => {
		floor = makeFloor(1);
		const keep = stage.createDiv({ cls: 'cos-term-tile' });
		const t = new TreeStage(host()); t.mount();
		t.unmount();
		expect(stage.children).toEqual([keep]);
		expect(stage.has('cos-tree-stage-on')).toBe(false);
	});
});
