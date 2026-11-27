// Tree Stage P4b — the Side Panel's pure decisions: whether the tree stage is on, how the stage's
// width is split (stageSplit), what each pane costs (paneMode), and the two rules that decide what
// lands in a slot — the click rule (design §9) and the attention rule (§10). No window, no DOM, no
// clock: the caller passes the time and the facts about each slot.
//
// The panel has two slots, A and B, fixed (D53). Each holds one session's tile, or nothing. The
// Terminal kind is the only kind in P4b (D50): a session's tile, a journal or the agent chat room,
// placed in a slot. The Chat view joins later as a second tab.
import { minTileSize, type CellMetrics } from '../terminals/bubble-layout';
import { minTreeWidth } from './tree-model';

/** `v2.treeStage` (Tree Stage P4b), default OFF. Off = today's grid, whole, with the layout
 *  selector. Only an explicit `true` turns it on. Applied live. */
export function parseTreeStageEnabled(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { treeStage?: unknown }).treeStage === true;
}

// ---- What a pane costs (D55).

export type PaneKind = 'terminal' | 'chat';
/** Terminal: the tile's own output modes (output-pacer.ts). Chat: how often the view is drawn. */
export type PaneCadence = 'live' | 'visible' | 'suspended' | 'coalesced' | 'none';

/** One pure function for every pane's cadence, tested the way the tile's outputMode is.
 *
 *  | Kind     | Focused | Visible, not focused | Hidden behind another tab |
 *  | terminal | live    | visible (300 ms)     | suspended (2 s)           |
 *  | chat     | live    | coalesced (1–2 s)    | none (reader kept alive)  |
 *
 *  Focus without visibility is not a state a pane can be in; it reads as hidden. */
export function paneMode(focused: boolean, visible: boolean, kind: PaneKind): PaneCadence {
	if (!visible) return kind === 'terminal' ? 'suspended' : 'none';
	if (focused) return 'live';
	return kind === 'terminal' ? 'visible' : 'coalesced';
}

// ---- The width (D58).

/** The tree's width when it is a rail of state dots. */
export const RAIL_W = 28;
/** The tree never takes more than this share of what the slots leave. */
export const TREE_MAX_SHARE = 0.4;

export interface StageSplit {
	/** How many slots fit: 2, or 1 — the second session then parks as a chip. */
	slots: 1 | 2;
	/** The tree's width. RAIL_W when it is a rail. */
	treeW: number;
	rail: boolean;
	/** Each slot's width. */
	slotW: number;
}

/** Split the stage row between the tree and the slots. Three decisions, in order:
 *
 *    1. two slots if  (stageW − dockW) − RAIL_W ≥ 2 × minTileSize(m).w,  else one
 *    2. the tree gets what its layout asks for, never more than 40% of what the slots leave
 *    3. if that is narrower than one card, the tree becomes a rail of state dots
 *
 *  `stageW` is the whole stage row, the overseer dock included; `dockW` is the dock's own width,
 *  which this never changes — it is an input so the floor can be stated in window terms. The test
 *  for "fits" is the Project panel's inequality (core/project-panel.ts panelPlacement): live cell
 *  metrics, never a pixel breakpoint. On the default metrics a slot is 80 × 7 + 10 = 570 px, so
 *  two need 1,140 px of stage beside a rail.
 *
 *  `opts.cardW` is the narrowest non-rail tree (one card). `opts.maxSlots` caps the count: with one
 *  session on the floor there is nothing for a second slot to hold, so the one slot fills the rest
 *  of the stage (design §5, "One session") — no threshold and no second layout. */
export function stageSplit(treeNeedW: number, dockW: number, stageW: number, metrics: CellMetrics, opts: { cardW?: number; maxSlots?: 1 | 2 } = {}): StageSplit {
	const cardW = opts.cardW ?? minTreeWidth();
	const usable = Math.max(0, stageW - dockW);
	const minW = minTileSize(metrics).w;
	const slots: 1 | 2 = usable - RAIL_W >= 2 * minW && opts.maxSlots !== 1 ? 2 : 1;
	const leftover = Math.max(0, usable - slots * minW);
	let treeW = Math.min(Math.max(0, treeNeedW), Math.floor(TREE_MAX_SHARE * leftover));
	const rail = treeW < cardW;
	if (rail) treeW = RAIL_W;
	const slotW = Math.max(0, Math.floor((usable - treeW) / slots));
	return { slots, treeW, rail, slotW };
}

// ---- The slots.

export type SlotId = 'A' | 'B';
export const SLOT_IDS: readonly SlotId[] = ['A', 'B'];

export interface Slot {
	/** The tile in this slot (the grid's tile id), or null when empty. */
	key: number | null;
	/** Alt+L: a pinned slot is never replaced by a click or by attention. Cleared when emptied. */
	pinned: boolean;
	/** When this slot was last given a session or focus — "used least recently" breaks ties. */
	usedAt: number;
}

export interface PanelState {
	slots: Record<SlotId, Slot>;
	/** The slot with keyboard focus — "being read". Null when focus is elsewhere. */
	focused: SlotId | null;
	/** With room for one slot only, slot B's session stays open as a chip here, not closed. */
	parked: number | null;
	/** No automatic opening before this (epoch ms): the 30 s hold after a manual choice. */
	holdUntil: number;
}

export function emptyPanel(): PanelState {
	return { slots: { A: { key: null, pinned: false, usedAt: 0 }, B: { key: null, pinned: false, usedAt: 0 } }, focused: null, parked: null, holdUntil: 0 };
}

/** What the caller knows about the session in a slot, now. */
export interface SlotFacts {
	/** Unsent text in its input box (a terminal's draft, a journal's unsaved edit). */
	draft: boolean;
	/** Messages waiting to be typed into it (the tile's NoticeGate queue). */
	queued: boolean;
	/** The session in it is idle — finished its turn, waiting on nobody. */
	idle: boolean;
}

export type FactsOf = (key: number) => SlotFacts;

const NO_FACTS: SlotFacts = { draft: false, queued: false, idle: true };

/** Which slots exist at this width. */
export function seatedSlots(seats: 1 | 2): SlotId[] {
	return seats === 2 ? ['A', 'B'] : ['A'];
}

/** Rule 3: a slot is never replaced while it has focus, an unsent draft, a queued message or a pin.
 *  An empty slot is never protected. */
export function isProtected(s: PanelState, id: SlotId, facts: FactsOf): boolean {
	const slot = s.slots[id];
	if (slot.key === null) return false;
	const f = facts(slot.key) ?? NO_FACTS;
	return s.focused === id || slot.pinned || f.draft || f.queued;
}

/** The slot a key is in, if any. */
export function slotOf(s: PanelState, key: number): SlotId | null {
	for (const id of SLOT_IDS) if (s.slots[id].key === key) return id;
	return null;
}

const put = (s: PanelState, id: SlotId, key: number | null, now: number): PanelState => ({
	...s,
	slots: { ...s.slots, [id]: { key, pinned: key === null ? false : (s.slots[id].key === key ? s.slots[id].pinned : false), usedAt: now } },
});

export type ClickOutcome =
	/** Rule 1: the node was already in a slot; that slot is focused, nothing moves. */
	| { kind: 'focus'; slot: SlotId }
	/** Rules 2 and 4: the node opened in this slot. */
	| { kind: 'open'; slot: SlotId }
	/** Rules 3 and 4: every seated slot is protected. The node is only selected, and its card
	 *  offers these slots as explicit controls (Open in A / Open in B, or Open here). */
	| { kind: 'select'; offer: SlotId[] };

/** The click rule (§9, D54), four cases:
 *
 *   1. a click on a node already in a slot focuses that slot — nothing moves;
 *   2. otherwise it opens in the slot not being read: the one without focus, or, if neither has
 *      focus, the one used least recently;
 *   3. a slot is never replaced while it is protected (isProtected); if every seated slot is,
 *      the click only selects the node;
 *   4. with room for one slot only, rule 3 still holds: an unprotected single slot is replaced,
 *      a protected one is not.
 *
 *  A manual choice starts the 30 s hold on automatic opening. The parked chip is not a slot: a
 *  click on the parked session opens it like any other node, and it leaves the chip. */
export function nodeClick(s: PanelState, key: number, seats: 1 | 2, facts: FactsOf, now: number, holdMs: number): { state: PanelState; outcome: ClickOutcome } {
	const held = { ...s, holdUntil: now + holdMs };
	const seated = seatedSlots(seats);
	const already = slotOf(s, key);
	if (already && seated.includes(already)) {
		return { state: { ...held, focused: already, slots: { ...held.slots, [already]: { ...held.slots[already], usedAt: now } } }, outcome: { kind: 'focus', slot: already } };
	}
	const target = pickClickSlot(s, seated, facts);
	if (!target) return { state: held, outcome: { kind: 'select', offer: seated } };
	// Opened in the slot not being read, and the reader keeps the keyboard: focus does not move.
	// A second click on the same node is rule 1, and focuses it.
	return { state: openIn(held, target, key, now, false), outcome: { kind: 'open', slot: target } };
}

function pickClickSlot(s: PanelState, seated: SlotId[], facts: FactsOf): SlotId | null {
	const open = seated.filter((id) => !isProtected(s, id, facts));
	if (open.length === 0) return null;
	if (open.length === 1) return open[0]!;
	// Both unprotected — so neither has focus. Empty first, then least recently used, then A.
	const empty = open.filter((id) => s.slots[id].key === null);
	const pool = empty.length ? empty : open;
	return [...pool].sort((a, b) => s.slots[a].usedAt - s.slots[b].usedAt || a.localeCompare(b))[0]!;
}

/** Put `key` in `slot` — the card's Open in A / Open in B, Alt+J's new journal, or a click the
 *  rule placed. Focus follows an explicit naming of the slot (`focus`, default true); a click the
 *  rule placed passes false. The same session's terminal cannot be in both slots: if it is already
 *  in the other, the two swap. */
export function openIn(s: PanelState, slot: SlotId, key: number, now: number, focus = true): PanelState {
	const other: SlotId = slot === 'A' ? 'B' : 'A';
	let next = s;
	if (s.slots[other].key === key) next = put(next, other, s.slots[slot].key, now);
	next = put(next, slot, key, now);
	return { ...next, focused: focus ? slot : next.focused, parked: next.parked === key ? null : next.parked };
}

/** Empty a slot (its ✕, or Alt+Backspace). The session keeps running; only the view goes. */
export function closeSlot(s: PanelState, slot: SlotId, now: number): PanelState {
	const next = put(s, slot, null, now);
	return { ...next, focused: next.focused === slot ? null : next.focused };
}

/** Alt+L: pin or unpin a slot. Pinning an empty slot does nothing. */
export function togglePin(s: PanelState, slot: SlotId): PanelState {
	const cur = s.slots[slot];
	if (cur.key === null) return s;
	return { ...s, slots: { ...s.slots, [slot]: { ...cur, pinned: !cur.pinned } } };
}

/** Keyboard focus landed in a slot (or left the panel: null). */
export function focusSlot(s: PanelState, slot: SlotId | null, now: number): PanelState {
	if (slot === null) return { ...s, focused: null };
	return { ...s, focused: slot, slots: { ...s.slots, [slot]: { ...s.slots[slot], usedAt: now } } };
}

/** Drop sessions that no longer exist, and fit the panel to the seats available: with one seat,
 *  slot B's session parks as a chip (never closed); with two again, the chip returns to B. */
export function reconcile(s: PanelState, alive: ReadonlySet<number>, seats: 1 | 2, now: number): PanelState {
	let next = s;
	for (const id of SLOT_IDS) {
		const k = next.slots[id].key;
		if (k !== null && !alive.has(k)) next = closeSlot(next, id, now);
	}
	if (next.parked !== null && !alive.has(next.parked)) next = { ...next, parked: null };
	if (seats === 1 && next.slots.B.key !== null) {
		const b = next.slots.B.key;
		next = closeSlot(next, 'B', now);
		next = { ...next, parked: b };
	}
	if (seats === 2 && next.parked !== null && next.slots.B.key === null) {
		const p = next.parked;
		next = { ...put(next, 'B', p, now), parked: null };
	}
	return next;
}

/** The parked chip was chosen: it swaps with A. An explicit choice, so focus goes to A. */
export function swapParked(s: PanelState, now: number): PanelState {
	if (s.parked === null) return s;
	const p = s.parked;
	const a = s.slots.A.key;
	const next = put(s, 'A', p, now);
	return { ...next, parked: a, focused: 'A' };
}

/** A slot is free to take a waiting session by itself (§10): not focused, no unsent draft, no
 *  queued message, no pin, and either empty or showing a session that is itself idle. */
export function isFree(s: PanelState, id: SlotId, facts: FactsOf): boolean {
	const slot = s.slots[id];
	if (s.focused === id || slot.pinned) return false;
	if (slot.key === null) return true;
	const f = facts(slot.key) ?? NO_FACTS;
	return !f.draft && !f.queued && f.idle;
}

/** The attention rule (§10, D57). A session just started waiting — on a prompt, a menu, or a
 *  finished turn. The badge on its node and the attention queue happen regardless (the caller's
 *  job); this decides only whether it ALSO opens by itself, and where:
 *
 *   - never into a slot that has focus or holds unsent text, and never by moving keyboard focus;
 *   - only into a slot that is free (isFree), an empty one before one showing an idle session;
 *   - not at all within the 30 s hold after a manual choice;
 *   - not at all when it is already in a slot, or when every seated slot is in use.
 *
 *  Returns the new state and the slot it opened in, or null — the badge and the queue only. */
export function attentionOpen(s: PanelState, key: number, seats: 1 | 2, facts: FactsOf, now: number): { state: PanelState; slot: SlotId | null } {
	if (now < s.holdUntil) return { state: s, slot: null };
	if (slotOf(s, key) !== null) return { state: s, slot: null };
	const free = seatedSlots(seats).filter((id) => isFree(s, id, facts));
	if (free.length === 0) return { state: s, slot: null };
	const empty = free.filter((id) => s.slots[id].key === null);
	const pool = empty.length ? empty : free;
	const slot = [...pool].sort((a, b) => s.slots[a].usedAt - s.slots[b].usedAt || a.localeCompare(b))[0]!;
	// put(), not openIn(): attention never moves keyboard focus, so `focused` is left alone.
	const next = put(s, slot, key, now);
	return { state: { ...next, parked: next.parked === key ? null : next.parked }, slot };
}
