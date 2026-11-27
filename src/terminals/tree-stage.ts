// Tree Stage P4b — the stage drawn as the lineage tree, with the two-slot Side Panel beside it.
// Behind `v2.treeStage` (core/side-panel.ts parseTreeStageEnabled), default off; the grid creates
// one of these only while it is on, and off gives back its own layout untouched.
//
// What this owns: the tree pane (nodes, edges, the Journals row, the chat room row), the two slots'
// chrome (header, pin, close, the parked chip), and WHERE each tile is. What it does not own: the
// tiles themselves, their sessions, the grid's hidden list, the attention queue in the top bar.
//
// Placement — the one place a tile is moved (`place`). A tile is never re-parented. Every tile is
// already an absolutely positioned child of the stage element, and stays one: a slot is a
// rectangle on the stage, and placing a tile in it is the same setRect the grid's own layout makes
// on every frame. Out of a slot, a tile is hidden (display:none), which is what the grid's own
// minimise does. So a WebGL-drawn terminal goes through exactly the two DOM operations it already
// survives today, and never the one the design was worried about (a move between parents).
// Whether it still DRAWS after those operations at these sizes has not been checked in the
// running app — see the PR.
//
// Cadence (core/side-panel.ts paneMode): the focused slot's tile is `centered` — the tile's `live`
// mode, and the only one whose pty is fitted; the other slot's is `visible` (300 ms batches); every
// tile not in a slot is hidden, which is `suspended` (2 s). A focus change only flips `centered`:
// it is a show-or-hide of cadence, never a move and a resize. The pty is refitted only when the
// focused slot's size really changes (FitThrottle dedupes the rest).
import { buildTeam, OVERSEER_ROLE, type TeamSession } from '../core/team';
import { layoutTree, readingOrder, stepSelection, minTreeWidth, DEFAULT_TREE_METRICS, UNCHECKED_TEXT, type NodeCard, type NodeDot, type TreeLayout, type NodeBox } from '../core/tree-model';
import {
	stageSplit, emptyPanel, nodeClick, openIn, closeSlot, togglePin, focusSlot, reconcile, swapParked, attentionOpen, slotOf, seatedSlots, paneMode,
	type PanelState, type SlotId, type SlotFacts, type StageSplit,
} from '../core/side-panel';
import { keyForIndex, type CellMetrics } from './bubble-layout';
import type { RoleLookup } from '../core/delegation';
import type { AttentionKind } from './attention';
import type { FloorSession } from '../core/session-requests';

/** The grid's 30 s hold after a manual choice (terminals-grid.ts MANUAL_HOLD_MS), reused. */
export const TREE_HOLD_MS = 30_000;
/** Height of a slot's header strip. */
export const SLOT_HEAD_H = 26;
const GAP = 4;

/** Anything the panel can hold: a session's terminal tile, a journal, the agent chat room. */
export interface Placeable {
	readonly key: number;
	readonly name: string;
	readonly branch: string;
	readonly kind: 'terminal' | 'journal' | 'chat';
	setRect(r: { x: number; y: number; w: number; h: number }): void;
	setCentered(on: boolean): void;
	setVisible(on: boolean): void;
	focus(): void;
}

export interface TreeStageHost {
	stage: HTMLElement;
	/** Every tile that can be placed in a slot — terminals (hidden ones too), journals, chat. */
	placeables(): Placeable[];
	/** The tree's sessions: the grid's floorSessions(), overseer included as key −1. */
	sessions(): FloorSession[];
	/** floorState()'s classified state and branch per key. */
	states(): Map<number, { state: string; branch: string }>;
	/** core/isolation.ts modeChip text for a session, or null. */
	isolationChip(key: number): string | null;
	/** `v2.managers` on: the active role files. Off: undefined, and no edge is checked. */
	delegation(): RoleLookup | undefined;
	/** `v2.managers` on: open proposals per addressee sessionId. */
	proposals(liveSessionIds: ReadonlySet<string>): Readonly<Record<string, number>> | undefined;
	facts(key: number): SlotFacts;
	metrics(): CellMetrics;
	/** The stage row: its whole width with the overseer dock in it, the dock's width, the height. */
	row(): { stageW: number; dockW: number; stageH: number };
	/** The overseer's node opens its dock, which is always on screen beside the stage. */
	focusOverseer(): void;
	now(): number;
}

const DOT_OF: Record<string, NodeDot> = { prompt: 'needs', menu: 'needs', errored: 'refused', idle: 'idle' };
/** The sidebar's dotFor (ui/sidebar-model.ts), repeated: classifier state → StateDot. */
export function dotOf(state: string): NodeDot { return DOT_OF[state] ?? 'running'; }

const ATTN_ICON: Record<AttentionKind, string> = { input: '⏳', help: '🆘', done: '✓' };

/** A classified state's attention bucket — attention.ts attentionKind over the same precedence,
 *  read from the state floorState() already classified, so a tick reads each screen once. */
export function attentionOfState(state: string | undefined): AttentionKind | null {
	if (state === 'prompt' || state === 'menu') return 'input';
	if (state === 'errored') return 'help';
	if (state === 'idle') return 'done';
	return null;
}

type States = Map<number, { state: string; branch: string }>;

export class TreeStage {
	private panel: PanelState = emptyPanel();
	private selected: number | null = null;
	private offer: SlotId[] | null = null;
	/** Viewer-only, like the sidebar's collapsed groups: never persisted. */
	private collapsed = new Set<string>();
	private journalsOpen = false;
	private badges = false;
	private lastAttn = new Map<number, AttentionKind | null>();
	private placed = new Map<number, string>();
	private paneEl: HTMLElement | null = null;
	private slotEls: Partial<Record<SlotId, HTMLElement>> = {};
	private lastSig = '';
	private model: TreeLayout | null = null;
	private split: StageSplit | null = null;

	constructor(private host: TreeStageHost) {}

	get state(): PanelState { return this.panel; }
	get selection(): number | null { return this.selected; }
	get layoutModel(): TreeLayout | null { return this.model; }
	get currentSplit(): StageSplit | null { return this.split; }

	mount(): void {
		const st = this.host.stage;
		st.toggleClass('cos-tree-stage-on', true);
		this.paneEl = st.createDiv({ cls: 'cos-tree-pane', attr: { tabindex: '0', role: 'tree', 'aria-label': 'Sessions' } });
		this.paneEl.addEventListener('keydown', (e) => this.onPaneKey(e as KeyboardEvent));
		this.paneEl.addEventListener('focus', () => { this.panel = focusSlot(this.panel, null, this.host.now()); });
		for (const id of ['A', 'B'] as SlotId[]) this.slotEls[id] = st.createDiv({ cls: `cos-slot cos-slot-${id.toLowerCase()}` });
		this.lastSig = '';
		this.placed.clear();
		this.layout();
	}

	/** Remove the tree's own DOM. Tiles are the grid's to restore — it knows which were hidden. */
	unmount(): void {
		this.host.stage.toggleClass('cos-tree-stage-on', false);
		this.paneEl?.remove(); this.paneEl = null;
		for (const id of ['A', 'B'] as SlotId[]) { this.slotEls[id]?.remove(); delete this.slotEls[id]; }
		this.placed.clear();
	}

	// ---- The model.

	private cards(sessions: FloorSession[], states: States): Map<number, NodeCard> {
		const live = new Set(sessions.map((s) => s.sessionId));
		const props = this.host.proposals(live);
		const out = new Map<number, NodeCard>();
		for (const s of sessions) {
			const st = states.get(s.key);
			const branch = (st?.branch ?? '').trim();
			out.set(s.key, {
				key: s.key, name: s.name, role: s.role,
				branch: branch && branch !== '—' ? branch : '—',
				isolation: s.key < 0 ? null : this.host.isolationChip(s.key),
				dot: dotOf(st?.state ?? 'running'),
				manager: false, // buildTeam's verdict replaces this in layoutTree
				proposals: props?.[s.sessionId] ?? 0,
				attention: attentionOfState(st?.state),
			});
		}
		return out;
	}

	private buildModel(states: States): TreeLayout {
		const sessions = this.host.sessions().filter((s) => !s.journal);
		const team: TeamSession[] = sessions.map((s) => ({
			key: s.key, sessionId: s.sessionId,
			role: s.key < 0 ? OVERSEER_ROLE : s.role,
			...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
		}));
		const delegation = this.host.delegation();
		return layoutTree(buildTeam(team, { delegation }), this.cards(sessions, states), { collapsed: this.collapsed, delegationOn: !!delegation });
	}

	/** Seats wanted: one session on the floor (besides the overseer, whose terminal is in the dock)
	 *  has nothing for a second slot to hold, so the one slot fills the stage. */
	private wantedSlots(): 1 | 2 {
		return this.host.placeables().length >= 2 ? 2 : 1;
	}

	// ---- Layout and drawing.

	layout(states: States = this.host.states()): void {
		if (!this.paneEl) return;
		const now = this.host.now();
		this.model = this.buildModel(states);
		const { stageW, dockW, stageH } = this.host.row();
		this.split = stageSplit(this.model.width, dockW, stageW, this.host.metrics(), { cardW: minTreeWidth(), maxSlots: this.wantedSlots() });
		const alive = new Set(this.host.placeables().map((p) => p.key));
		this.panel = reconcile(this.panel, alive, this.split.slots, now);
		if (this.selected !== null && !this.model.nodes.some((n) => n.key === this.selected)) { this.selected = null; this.offer = null; }
		const sig = JSON.stringify([this.model, this.split, this.panel.slots, this.panel.parked, this.panel.focused, this.selected, this.offer, this.journalsOpen, this.badges, stageH, this.journalNames()]);
		if (sig !== this.lastSig) {
			this.lastSig = sig;
			this.drawPane(stageH);
			this.drawSlots(stageH);
		}
		this.placeAll(stageH);
	}

	private journalNames(): string[] {
		return this.host.placeables().filter((p) => p.kind !== 'terminal').map((p) => `${p.key}:${p.name}`);
	}

	private drawPane(stageH: number): void {
		const pane = this.paneEl!;
		const split = this.split!;
		const model = this.model!;
		pane.empty();
		pane.style.left = '0px';
		pane.style.top = '0px';
		pane.style.width = `${split.treeW}px`;
		pane.style.height = `${stageH}px`;
		pane.toggleClass('cos-tree-rail', split.rail);
		const order = readingOrder(model);
		const badgeOf = new Map(order.map((n, i) => [n.key, i]));
		if (split.rail) {
			for (const n of order) {
				const dot = pane.createDiv({ cls: `cos-tree-raildot cos-dot dot-${n.card.dot}`, attr: { title: `${n.card.name} — ${n.card.role}`, 'data-key': String(n.key) } });
				dot.addEventListener('click', () => this.clickNode(n.key));
			}
			this.drawExtras(pane);
			return;
		}
		const canvas = pane.createDiv({ cls: 'cos-tree-canvas' });
		canvas.style.width = `${model.width}px`;
		canvas.style.height = `${model.height}px`;
		for (const e of model.edges) this.drawEdge(canvas, e.d, e.unchecked ? UNCHECKED_TEXT[e.unchecked] : null);
		if (model.unassignedLabelY !== null) {
			const l = canvas.createDiv({ cls: 'cos-tree-group-label', text: 'Unassigned' });
			l.style.left = `${DEFAULT_TREE_METRICS.pad}px`;
			l.style.top = `${model.unassignedLabelY}px`;
		}
		for (const n of model.nodes) this.drawNode(canvas, n, badgeOf.get(n.key)!);
		this.drawExtras(pane);
	}

	/** An elbow edge as three axis-aligned segments (no SVG: the stage is plain positioned DOM).
	 *  The path it was cut from rides along in data-d, so a test can read the geometry back. */
	private drawEdge(canvas: HTMLElement, d: string, unchecked: string | null): void {
		const m = /^M(\S+) (\S+) H(\S+) V(\S+) H(\S+)$/.exec(d);
		if (!m) return;
		const [x1, y1, mx, y2, x2] = m.slice(1).map(Number) as [number, number, number, number, number];
		const edge = canvas.createDiv({ cls: `cos-tree-edge${unchecked ? ' unchecked' : ''}`, attr: { 'data-d': d, ...(unchecked ? { title: unchecked } : {}) } });
		const seg = (x: number, y: number, w: number, h: number): void => {
			const s = edge.createDiv({ cls: `cos-tree-seg ${h === 0 ? 'h' : 'v'}` });
			s.style.left = `${x}px`; s.style.top = `${y}px`; s.style.width = `${w}px`; s.style.height = `${h}px`;
		};
		seg(x1, y1, mx - x1, 0);
		seg(mx, Math.min(y1, y2), 0, Math.abs(y2 - y1));
		seg(mx, y2, x2 - mx, 0);
	}

	private drawNode(canvas: HTMLElement, n: NodeBox, badgeIndex: number): void {
		const c = n.card;
		const inSlot = slotOf(this.panel, n.key);
		const cls = ['cos-tree-node', `dot-${c.dot}`];
		if (n.group === 'unassigned') cls.push('unassigned');
		if (this.selected === n.key) cls.push('selected');
		if (inSlot) cls.push('in-slot');
		if (this.panel.parked === n.key) cls.push('parked');
		const title = [c.name, `${c.role}${c.isolation ? ` · ${c.isolation}` : ''}`, c.branch, n.reason ? `Unassigned: ${n.reason}` : ''].filter(Boolean).join('\n');
		const el = canvas.createDiv({ cls: cls.join(' '), attr: { 'data-key': String(n.key), role: 'treeitem', title } });
		el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; el.style.width = `${n.w}px`; el.style.height = `${n.h}px`;
		el.addEventListener('click', () => this.clickNode(n.key));
		const l1 = el.createDiv({ cls: 'cos-tree-node-l1' });
		l1.createSpan({ cls: `cos-dot dot-${c.dot}` });
		if (n.card.role === OVERSEER_ROLE && n.key < 0) l1.createSpan({ cls: 'cos-tree-glyph', text: '🜲' });
		l1.createSpan({ cls: 'cos-tree-name', text: c.name });
		if (c.manager) l1.createSpan({ cls: 'cos-tree-manager', text: '★', attr: { title: 'Manager — its role file declares spawns:' } });
		if (c.proposals > 0) l1.createSpan({ cls: 'cos-tree-proposals', text: `◆${c.proposals}`, attr: { title: `${c.proposals} open spawn proposal${c.proposals === 1 ? '' : 's'}` } });
		if (c.attention) l1.createSpan({ cls: `cos-tree-attn attn-${c.attention}`, text: ATTN_ICON[c.attention] });
		if (inSlot) l1.createSpan({ cls: 'cos-tree-slottag', text: inSlot });
		if (this.badges) l1.createSpan({ cls: 'cos-tree-badge', text: keyForIndex(badgeIndex) });
		el.createDiv({ cls: 'cos-tree-node-l2', text: `${c.role || '—'}${c.isolation ? ` · ${c.isolation}` : ''}` });
		el.createDiv({ cls: 'cos-tree-node-l3', text: c.branch });
		if (n.reason) el.createDiv({ cls: 'cos-tree-reason', text: n.reason });
		if (n.hasChildren) {
			const open = n.hiddenBelow === 0;
			const t = el.createSpan({ cls: 'cos-tree-toggle', text: open ? '▾' : `▸ ${n.hiddenBelow}`, attr: { title: open ? 'Collapse' : `Expand — ${n.hiddenBelow} hidden` } });
			t.addEventListener('click', (e) => { (e as Event).stopPropagation(); this.toggleCollapsed(n.sessionId); });
		}
		if (this.selected === n.key && this.offer) {
			const row = el.createDiv({ cls: 'cos-tree-offer' });
			const labels: Record<SlotId, string> = this.offer.length === 1 ? { A: 'Open here', B: 'Open here' } : { A: 'Open in A', B: 'Open in B' };
			for (const id of this.offer) {
				const b = row.createEl('button', { text: labels[id], cls: 'cos-tree-offer-btn' });
				b.addEventListener('click', (e) => { (e as Event).stopPropagation(); this.openExplicit(n.key, id); });
			}
		}
	}

	/** Under the tree: Journals (n), and the agent chat room when one is open. Neither is a node:
	 *  "Journals are notes, not sessions" (lineage.ts). Each opens in the Side Panel. */
	private drawExtras(pane: HTMLElement): void {
		const extras = this.host.placeables().filter((p) => p.kind !== 'terminal');
		const journals = extras.filter((p) => p.kind === 'journal');
		const chat = extras.find((p) => p.kind === 'chat');
		const box = pane.createDiv({ cls: 'cos-tree-extras' });
		if (journals.length) {
			const head = box.createDiv({ cls: 'cos-tree-extra-head', text: `${this.journalsOpen ? '▾' : '▸'} Journals (${journals.length})` });
			head.addEventListener('click', () => { this.journalsOpen = !this.journalsOpen; this.layout(); });
			if (this.journalsOpen) {
				for (const j of journals) {
					const inSlot = slotOf(this.panel, j.key);
					const r = box.createDiv({ cls: `cos-tree-extra-row${inSlot ? ' in-slot' : ''}`, text: inSlot ? `${j.name} · ${inSlot}` : j.name, attr: { 'data-key': String(j.key) } });
					r.addEventListener('click', () => this.clickNode(j.key));
				}
			}
		}
		if (chat) {
			const r = box.createDiv({ cls: 'cos-tree-extra-head', text: '💬 Chat room', attr: { 'data-key': String(chat.key) } });
			r.addEventListener('click', () => this.clickNode(chat.key));
		}
	}

	private slotRect(id: SlotId, stageH: number): { x: number; y: number; w: number; h: number } {
		const s = this.split!;
		const i = id === 'A' ? 0 : 1;
		return { x: s.treeW + i * s.slotW, y: 0, w: s.slotW, h: stageH };
	}

	private drawSlots(stageH: number): void {
		const seated = seatedSlots(this.split!.slots);
		const byKey = new Map(this.host.placeables().map((p) => [p.key, p]));
		for (const id of ['A', 'B'] as SlotId[]) {
			const el = this.slotEls[id];
			if (!el) continue;
			el.empty();
			if (!seated.includes(id)) { el.style.display = 'none'; continue; }
			el.style.display = '';
			const r = this.slotRect(id, stageH);
			el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
			const slot = this.panel.slots[id];
			el.toggleClass('focused', this.panel.focused === id);
			el.toggleClass('pinned', slot.pinned);
			const head = el.createDiv({ cls: 'cos-slot-head' });
			const p = slot.key !== null ? byKey.get(slot.key) : undefined;
			head.createSpan({ cls: 'cos-slot-title', text: p ? [id, p.name, p.branch].filter(Boolean).join(' · ') : `${id} · empty` });
			if (id === 'A' && this.panel.parked !== null) {
				const parked = byKey.get(this.panel.parked);
				if (parked) {
					const chip = head.createEl('button', { cls: 'cos-slot-parked', text: `parked: ${parked.name} ⇄`, attr: { title: 'Two slots do not fit at this width. Swap this session into the slot.' } });
					chip.addEventListener('click', (e) => { (e as Event).stopPropagation(); this.panel = swapParked(this.panel, this.host.now()); this.layout(); this.focusPanelTile(); });
				}
			}
			if (p) {
				const pin = head.createEl('button', { cls: `cos-slot-pin${slot.pinned ? ' on' : ''}`, text: '📌', attr: { title: slot.pinned ? 'Unpin (Alt+L)' : 'Pin — never replaced by a click or by attention (Alt+L)' } });
				pin.addEventListener('click', (e) => { (e as Event).stopPropagation(); this.panel = togglePin(this.panel, id); this.layout(); });
				const x = head.createEl('button', { cls: 'cos-slot-close', text: '✕', attr: { title: 'Close this slot — the session keeps running' } });
				x.addEventListener('click', (e) => { (e as Event).stopPropagation(); this.panel = closeSlot(this.panel, id, this.host.now()); this.layout(); });
			} else {
				el.createDiv({ cls: 'cos-slot-empty', text: 'Click a node to open it here.' });
			}
		}
	}

	/** Put every tile where the panel says, through `place` — the one place a tile moves. */
	private placeAll(stageH: number): void {
		const seated = seatedSlots(this.split!.slots);
		for (const p of this.host.placeables()) {
			const id = slotOf(this.panel, p.key);
			if (id && seated.includes(id)) {
				const r = this.slotRect(id, stageH);
				this.place(p, { x: r.x + GAP, y: r.y + SLOT_HEAD_H, w: r.w - 2 * GAP, h: r.h - SLOT_HEAD_H - GAP }, this.panel.focused === id);
			} else {
				this.place(p, null, false);
			}
		}
	}

	/** The one place a tile is moved. `rect` null = not in a slot: hidden, suspended. Each call only
	 *  touches what changed, so a focus flip is setCentered alone and never a resize. */
	private place(p: Placeable, rect: { x: number; y: number; w: number; h: number } | null, focused: boolean): void {
		const cadence = paneMode(focused, rect !== null, 'terminal');
		const sig = rect ? `${rect.x},${rect.y},${rect.w},${rect.h}|${cadence}` : 'hidden';
		const prev = this.placed.get(p.key);
		if (prev === sig) return;
		this.placed.set(p.key, sig);
		if (!rect) { p.setCentered(false); p.setVisible(false); return; }
		const prevRect = prev && prev !== 'hidden' ? prev.split('|')[0] : null;
		if (prev === undefined || prev === 'hidden') p.setVisible(true);
		if (prevRect !== sig.split('|')[0]) p.setRect(rect);
		p.setCentered(cadence === 'live');
	}

	// ---- What the person does.

	/** A node (or a journal, or the chat room) was clicked: the click rule. */
	clickNode(key: number): void {
		if (key < 0) { this.host.focusOverseer(); return; }
		const r = nodeClick(this.panel, key, this.split?.slots ?? 1, (k) => this.host.facts(k), this.host.now(), TREE_HOLD_MS);
		this.panel = r.state;
		this.selected = key;
		this.offer = r.outcome.kind === 'select' ? r.outcome.offer : null;
		this.layout();
		// Rule 1 focuses; an open lands in the slot NOT being read, so the reader keeps the keyboard.
		// Either way, give DOM focus back to whichever slot is being read — the click on the tree took it.
		this.focusPanelTile();
	}

	/** Jump to a session from outside the tree (the ⚠ queue, the sidebar, the Project panel, the
	 *  Coordination board): the click rule decides the slot, then that slot gets focus. */
	reveal(key: number): void {
		if (key < 0) { this.host.focusOverseer(); return; }
		const r = nodeClick(this.panel, key, this.split?.slots ?? 1, (k) => this.host.facts(k), this.host.now(), TREE_HOLD_MS);
		this.panel = r.state;
		this.selected = key;
		this.offer = r.outcome.kind === 'select' ? r.outcome.offer : null;
		if (r.outcome.kind !== 'select') this.panel = focusSlot(this.panel, r.outcome.slot, this.host.now());
		this.layout();
		this.focusPanelTile();
	}

	/** Open in a named slot — the card's Open in A / B, or Alt+J's new journal. Focus follows. */
	openExplicit(key: number, slot?: SlotId): void {
		const seated = seatedSlots(this.split?.slots ?? 1);
		const into = slot && seated.includes(slot) ? slot : (seated.find((id) => this.panel.focused !== id && this.panel.slots[id].key === null) ?? seated.find((id) => this.panel.focused !== id) ?? 'A');
		this.panel = { ...openIn(this.panel, into, key, this.host.now()), holdUntil: this.host.now() + TREE_HOLD_MS };
		this.selected = key;
		this.offer = null;
		this.layout();
		this.focusPanelTile();
	}

	/** A click inside a tile that is in a slot focuses that slot (rule 1). */
	tileClicked(key: number): void {
		const id = slotOf(this.panel, key);
		if (!id) { this.clickNode(key); return; }
		this.panel = focusSlot(this.panel, id, this.host.now());
		this.layout();
		// The tile's own mousedown guard swallowed the press that would have focused xterm.
		this.focusPanelTile();
	}

	/** DOM focus entered a tile. Leaving one changes nothing: "being read" is the slot that last
	 *  had the keyboard, and a click on the tree must not count as reading neither. */
	tileFocused(key: number): void {
		const id = slotOf(this.panel, key);
		if (!id || this.panel.focused === id) return;
		this.panel = focusSlot(this.panel, id, this.host.now());
		this.layout();
	}

	/** The overseer dock took the keyboard: no slot is being read. */
	blurPanel(): void { if (this.panel.focused !== null) { this.panel = focusSlot(this.panel, null, this.host.now()); this.layout(); } }

	/** Give DOM focus to the slot being read (window refocus, workspace re-mount). */
	refocus(): void { this.focusPanelTile(); }

	private focusPanelTile(): void {
		const id = this.panel.focused;
		if (!id) return;
		const key = this.panel.slots[id].key;
		const p = key !== null ? this.host.placeables().find((x) => x.key === key) : undefined;
		p?.focus();
	}

	toggleCollapsed(sessionId: string): void {
		if (this.collapsed.has(sessionId)) this.collapsed.delete(sessionId); else this.collapsed.add(sessionId);
		this.layout();
	}

	// ---- Keys (§10).

	/** Alt+←/→, or ←/→ alone with the tree focused: move the selection between sibling nodes. */
	stepSelection(dir: 1 | -1): void {
		if (!this.model) return;
		this.selected = stepSelection(this.model, this.selected, dir);
		this.offer = null;
		this.layout();
	}

	/** Alt+F-key / letter badge: jump to the i-th node in reading order — the click rule. */
	jumpTo(index: number): boolean {
		const n = this.model ? readingOrder(this.model)[index] : undefined;
		if (!n) return false;
		this.clickNode(n.key);
		return true;
	}

	setBadges(on: boolean): void { if (this.badges !== on) { this.badges = on; this.layout(); } }

	/** Alt+L: pin the focused slot. */
	pinFocused(): void {
		if (!this.panel.focused) return;
		this.panel = togglePin(this.panel, this.panel.focused);
		this.layout();
	}

	/** A tile's own 🔒 button: pin the slot it is in. */
	pinTile(key: number): void {
		const id = slotOf(this.panel, key);
		if (!id) return;
		this.panel = togglePin(this.panel, id);
		this.layout();
	}

	/** Alt+[ / Alt+]: focus slot A / B. */
	focusSlotKey(id: SlotId): void {
		if (!seatedSlots(this.split?.slots ?? 1).includes(id) || this.panel.slots[id].key === null) return;
		this.panel = focusSlot(this.panel, id, this.host.now());
		this.layout();
		this.focusPanelTile();
	}

	/** Alt+Backspace: close the focused slot. The session keeps running. */
	closeFocused(): void {
		if (!this.panel.focused) return;
		this.panel = closeSlot(this.panel, this.panel.focused, this.host.now());
		this.layout();
	}

	/** A tile left the panel's world (hidden by its own –): empty its slot. */
	vacate(key: number): void {
		const id = slotOf(this.panel, key);
		if (id) { this.panel = closeSlot(this.panel, id, this.host.now()); this.layout(); }
	}

	private onPaneKey(e: KeyboardEvent): void {
		if (e.altKey) return; // the grid's document handler owns Alt+ keys
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this.stepSelection(1); return; }
		if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this.stepSelection(-1); return; }
		if (e.key === 'Enter' && this.selected !== null) { e.preventDefault(); this.clickNode(this.selected); }
	}

	// ---- Attention (§10).

	/** Run every second with the grid's spotlight tick. A session that just started waiting gets its
	 *  badge (drawn from attention() on the next layout) and the top bar's queue (the grid's
	 *  existing updateAttention); it opens by itself only into a free slot (attentionOpen). */
	tick(): void {
		if (!this.paneEl) return;
		const now = this.host.now();
		const seats = this.split?.slots ?? 1;
		const states = this.host.states();
		const keys = new Set(this.host.placeables().filter((p) => p.kind === 'terminal').map((p) => p.key));
		for (const key of keys) {
			const kind = attentionOfState(states.get(key)?.state);
			const prev = this.lastAttn.get(key);
			this.lastAttn.set(key, kind);
			// First sighting seeds silently, exactly like the grid's lastAttn: a restore is not news.
			if (prev === undefined || prev === kind || kind === null) continue;
			const r = attentionOpen(this.panel, key, seats, (k) => this.host.facts(k), now);
			this.panel = r.state;
		}
		for (const k of [...this.lastAttn.keys()]) if (!keys.has(k)) this.lastAttn.delete(k);
		this.layout(states);
	}
}

