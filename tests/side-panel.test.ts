import { describe, it, expect } from 'vitest';
import {
	parseTreeStageEnabled, paneMode, stageSplit, RAIL_W, emptyPanel, nodeClick, openIn, closeSlot, togglePin, focusSlot,
	reconcile, swapParked, attentionOpen, isFree, isProtected, type PanelState, type SlotFacts, type FactsOf,
} from '../src/core/side-panel';
import { DEFAULT_CELL_METRICS, minTileSize, type CellMetrics } from '../src/terminals/bubble-layout';
import { minTreeWidth } from '../src/core/tree-model';

const HOLD = 30_000;
const quiet: SlotFacts = { draft: false, queued: false, idle: false };
const factsMap = (m: Record<number, Partial<SlotFacts>> = {}): FactsOf => (k) => ({ ...quiet, ...m[k] });
const withSlots = (a: number | null, b: number | null, over: Partial<PanelState> = {}): PanelState => {
	const s = emptyPanel();
	return { ...s, slots: { A: { key: a, pinned: false, usedAt: 1 }, B: { key: b, pinned: false, usedAt: 2 } }, ...over };
};

describe('v2.treeStage', () => {
	it('is off unless set to exactly true, and is its own key', () => {
		expect(parseTreeStageEnabled(undefined)).toBe(false);
		expect(parseTreeStageEnabled(null)).toBe(false);
		expect(parseTreeStageEnabled({ treeStage: 'yes' })).toBe(false);
		expect(parseTreeStageEnabled({ treeStage: 1 })).toBe(false);
		expect(parseTreeStageEnabled({ projectLanes: true, teamView: true })).toBe(false);
		expect(parseTreeStageEnabled({ treeStage: true })).toBe(true);
	});
});

describe('paneMode — the table, as built', () => {
	it.each([
		['terminal', true, true, 'live'],
		['terminal', false, true, 'visible'],
		['terminal', false, false, 'suspended'],
		['terminal', true, false, 'suspended'], // focus without visibility is not a state: reads as hidden
		['chat', true, true, 'live'],
		['chat', false, true, 'coalesced'],
		['chat', false, false, 'none'],
		['chat', true, false, 'none'],
	] as const)('%s, focused=%s visible=%s → %s', (kind, focused, visible, want) => {
		expect(paneMode(focused, visible, kind)).toBe(want);
	});
});

describe('stageSplit — the floor, and the three decisions', () => {
	const m = DEFAULT_CELL_METRICS;
	const slot = minTileSize(m).w; // 80 × 7 + 10
	const card = minTreeWidth();

	it('two slots on the default metrics need 1,140 px beside a rail', () => {
		expect(slot).toBe(570);
		expect(stageSplit(200, 0, 2 * slot + RAIL_W, m).slots).toBe(2);
		expect(stageSplit(200, 0, 2 * slot + RAIL_W - 1, m).slots).toBe(1);
	});

	it('states the floor in window terms: the dock is subtracted, never resized', () => {
		const dock = 320;
		expect(stageSplit(200, dock, dock + 2 * slot + RAIL_W, m).slots).toBe(2);
		expect(stageSplit(200, dock, dock + 2 * slot + RAIL_W - 1, m).slots).toBe(1);
		// With the 248 px sidebar beside it, a window below sidebar + dock + 1,168 never seats two.
		const window = 248 + dock + 2 * slot + RAIL_W;
		expect(window).toBe(1736);
	});

	it('is an inequality on live metrics, not a breakpoint: a bigger font seats one in the same width', () => {
		const big: CellMetrics = { ...m, cw: 9 };
		expect(stageSplit(200, 0, 1400, m).slots).toBe(2);
		expect(stageSplit(200, 0, 1400, big).slots).toBe(1);
	});

	it('the tree gets what it asks for, never more than 40% of what the slots leave', () => {
		const s = stageSplit(400, 0, 2000, m); // two slots leave 2000 − 1140 = 860; 40% = 344
		expect(s).toEqual({ slots: 2, treeW: 344, rail: false, slotW: Math.floor((2000 - 344) / 2) });
		expect(stageSplit(200, 0, 2000, m).treeW).toBe(200);
	});

	it('narrower than one card, the tree is a rail of dots', () => {
		const s = stageSplit(card, 0, 2 * slot + RAIL_W + 10, m);
		expect(s.rail).toBe(true);
		expect(s.treeW).toBe(RAIL_W);
	});

	it('one session: the tree is one card, the single slot fills the rest of the stage', () => {
		const s = stageSplit(card, 0, 1600, m, { maxSlots: 1 });
		expect(s).toEqual({ slots: 1, treeW: card, rail: false, slotW: 1600 - card });
		expect(stageSplit(card, 0, 1600, m).slots).toBe(2); // the same width seats two when there are two to seat
	});
});

describe('the click rule — four cases', () => {
	it('1. a click on a node already in a slot focuses that slot; nothing moves', () => {
		const s = withSlots(10, 20, { focused: 'A' });
		const r = nodeClick(s, 20, 2, factsMap(), 100, HOLD);
		expect(r.outcome).toEqual({ kind: 'focus', slot: 'B' });
		expect([r.state.slots.A.key, r.state.slots.B.key]).toEqual([10, 20]);
		expect(r.state.focused).toBe('B');
	});

	it('2. otherwise it opens in the slot not being read — the one without focus', () => {
		const s = withSlots(10, 20, { focused: 'A' });
		const r = nodeClick(s, 30, 2, factsMap(), 100, HOLD);
		expect(r.outcome).toEqual({ kind: 'open', slot: 'B' });
		expect([r.state.slots.A.key, r.state.slots.B.key]).toEqual([10, 30]);
		expect(r.state.focused).toBe('A'); // the reader keeps the keyboard
		// and a second click on the same node is case 1: it focuses B.
		expect(nodeClick(r.state, 30, 2, factsMap(), 101, HOLD).outcome).toEqual({ kind: 'focus', slot: 'B' });
	});

	it('2. with neither focused, the slot used least recently; an empty slot first', () => {
		const lru = withSlots(10, 20); // A used at 1, B at 2
		expect(nodeClick(lru, 30, 2, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'open', slot: 'A' });
		const oneEmpty = withSlots(10, null);
		expect(nodeClick(oneEmpty, 30, 2, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'open', slot: 'B' });
		expect(nodeClick(emptyPanel(), 30, 2, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'open', slot: 'A' });
	});

	it('3. a slot with a draft, a queued message or a pin is never replaced', () => {
		for (const f of [{ draft: true }, { queued: true }]) {
			const r = nodeClick(withSlots(10, 20, { focused: 'A' }), 30, 2, factsMap({ 20: f }), 100, HOLD);
			expect(r.outcome).toEqual({ kind: 'select', offer: ['A', 'B'] });
			expect([r.state.slots.A.key, r.state.slots.B.key]).toEqual([10, 20]);
		}
		const pinned = togglePin(withSlots(10, 20, { focused: 'A' }), 'B');
		expect(nodeClick(pinned, 30, 2, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'select', offer: ['A', 'B'] });
	});

	it('3. with only one slot protected and neither focused, the other takes it', () => {
		const s = togglePin(withSlots(10, 20), 'A');
		expect(nodeClick(s, 30, 2, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'open', slot: 'B' });
	});

	it('3. both protected: the card offers Open in A / Open in B, and either works', () => {
		const s = withSlots(10, 20, { focused: 'A' });
		const f = factsMap({ 20: { draft: true } });
		expect(nodeClick(s, 30, 2, f, 100, HOLD).outcome.kind).toBe('select');
		const intoB = openIn(s, 'B', 30, 200);
		expect([intoB.slots.A.key, intoB.slots.B.key, intoB.focused]).toEqual([10, 30, 'B']);
	});

	it('4. one seat: an unprotected slot is replaced; a protected one offers Open here', () => {
		const idle = withSlots(10, null);
		expect(nodeClick(idle, 30, 1, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'open', slot: 'A' });
		const busy = withSlots(10, null, { focused: 'A' });
		expect(nodeClick(busy, 30, 1, factsMap(), 100, HOLD).outcome).toEqual({ kind: 'select', offer: ['A'] });
		const drafted = withSlots(10, null);
		expect(nodeClick(drafted, 30, 1, factsMap({ 10: { draft: true } }), 100, HOLD).outcome).toEqual({ kind: 'select', offer: ['A'] });
	});

	it('the same session cannot be in both slots: opening it in the other swaps them', () => {
		const s = openIn(withSlots(10, 20), 'A', 20, 100);
		expect([s.slots.A.key, s.slots.B.key]).toEqual([20, 10]);
	});

	it('a click starts the 30 s hold on automatic opening', () => {
		const r = nodeClick(emptyPanel(), 30, 2, factsMap(), 1000, HOLD);
		expect(r.state.holdUntil).toBe(1000 + HOLD);
	});
});

describe('the attention rule', () => {
	const t0 = 100_000;

	it('opens into an empty, unfocused slot — without moving focus', () => {
		const s = withSlots(10, null, { focused: 'A' });
		const r = attentionOpen(s, 30, 2, factsMap(), t0);
		expect(r.slot).toBe('B');
		expect(r.state.slots.B.key).toBe(30);
		expect(r.state.focused).toBe('A');
	});

	it('may replace a slot showing an idle session, but an empty one first', () => {
		const s = withSlots(10, null);
		expect(attentionOpen(s, 30, 2, factsMap({ 10: { idle: true } }), t0).slot).toBe('B');
		const full = withSlots(10, 20);
		expect(attentionOpen(full, 30, 2, factsMap({ 20: { idle: true } }), t0).slot).toBe('B');
	});

	it('never into a focused slot, one with unsent text, a queued message, a pin, or a working session', () => {
		const f = factsMap({ 10: { idle: true } });
		expect(isFree(withSlots(10, null, { focused: 'A' }), 'A', f)).toBe(false);
		expect(isFree(withSlots(10, null), 'A', factsMap({ 10: { idle: true, draft: true } }))).toBe(false);
		expect(isFree(withSlots(10, null), 'A', factsMap({ 10: { idle: true, queued: true } }))).toBe(false);
		expect(isFree(togglePin(withSlots(10, null), 'A'), 'A', f)).toBe(false);
		expect(isFree(withSlots(10, null), 'A', factsMap({ 10: { idle: false } }))).toBe(false);
		expect(isFree(withSlots(10, null), 'A', f)).toBe(true);
	});

	it('when both slots are in use: the badge and the queue, and nothing else', () => {
		const s = withSlots(10, 20, { focused: 'A' });
		const r = attentionOpen(s, 30, 2, factsMap(), t0); // B is working (not idle) and A has focus
		expect(r.slot).toBeNull();
		expect(r.state).toBe(s);
	});

	it('when both slots are protected — focus in one, a draft in the other — nothing moves', () => {
		const s = withSlots(10, 20, { focused: 'A' });
		const f = factsMap({ 10: { idle: true }, 20: { idle: true, draft: true } });
		expect(isProtected(s, 'A', f) && isProtected(s, 'B', f)).toBe(true);
		expect(attentionOpen(s, 30, 2, f, t0)).toEqual({ state: s, slot: null });
	});

	it('nothing opens by itself within 30 s of a manual choice', () => {
		const clicked = nodeClick(emptyPanel(), 10, 2, factsMap(), t0, HOLD).state;
		expect(attentionOpen(clicked, 30, 2, factsMap(), t0 + HOLD - 1).slot).toBeNull();
		expect(attentionOpen(clicked, 30, 2, factsMap(), t0 + HOLD).slot).toBe('B');
	});

	it('a session already in a slot is not opened again', () => {
		const s = withSlots(30, null);
		expect(attentionOpen(s, 30, 2, factsMap(), t0).slot).toBeNull();
	});

	it('with one seat, only A — and only if it is free', () => {
		expect(attentionOpen(emptyPanel(), 30, 1, factsMap(), t0).slot).toBe('A');
		expect(attentionOpen(withSlots(10, null), 30, 1, factsMap(), t0).slot).toBeNull();
	});
});

describe('slots across widths — the parked chip', () => {
	it('one seat parks slot B\'s session as a chip, never closing it; two seats bring it back', () => {
		const two = withSlots(10, 20);
		const one = reconcile(two, new Set([10, 20]), 1, 5);
		expect([one.slots.A.key, one.slots.B.key, one.parked]).toEqual([10, null, 20]);
		const back = reconcile(one, new Set([10, 20]), 2, 6);
		expect([back.slots.A.key, back.slots.B.key, back.parked]).toEqual([10, 20, null]);
	});

	it('choosing the chip swaps it with A', () => {
		const one = reconcile(withSlots(10, 20), new Set([10, 20]), 1, 5);
		const swapped = swapParked(one, 7);
		expect([swapped.slots.A.key, swapped.parked, swapped.focused]).toEqual([20, 10, 'A']);
	});

	it('a closed session leaves its slot and the chip', () => {
		const s = reconcile({ ...withSlots(10, 20), parked: 30 }, new Set([10]), 2, 5);
		expect([s.slots.A.key, s.slots.B.key, s.parked]).toEqual([10, null, null]);
	});
});

describe('slot controls', () => {
	it('closing a slot empties it, clears its pin and its focus', () => {
		const s = closeSlot(togglePin(withSlots(10, 20, { focused: 'B' }), 'B'), 'B', 9);
		expect([s.slots.B.key, s.slots.B.pinned, s.focused]).toEqual([null, false, null]);
	});

	it('an empty slot cannot be pinned', () => {
		expect(togglePin(emptyPanel(), 'A').slots.A.pinned).toBe(false);
	});

	it('focus marks a slot as used', () => {
		expect(focusSlot(withSlots(10, 20), 'A', 50).slots.A.usedAt).toBe(50);
		expect(focusSlot(withSlots(10, 20, { focused: 'A' }), null, 50).focused).toBeNull();
	});
});
