// Tree Stage P4b — the lineage tree as a drawing. Pure: no window, no DOM, no clock. The same team
// tree and the same size in, the same boxes and paths out.
//
// The tree comes from core/team.ts buildTeam — the same source the sidebar's team view reads — so
// the two views cannot disagree about who answers to whom. What this adds is geometry: the root at
// the left, depth running right, each node a fixed-size card. It is not the sidebar's model
// (ui/sidebar-model.ts flattens the tree into indented lines, the right output for a list and the
// wrong input for a drawing).
//
//   x  = pad + depth × (card + column gap)          — depth is the only thing x encodes
//   y  = leaves take successive rows, top to bottom in declared order; a parent sits level with
//        the middle of its first and last child, so a branch reads as one block
//
// Deterministic, no physics, nothing stored: positions are recomputed on every draw, so there is
// nothing for persist() to overwrite and nothing to migrate (design D22). A collapsed subtree is
// viewer state the caller passes in, like the sidebar's collapsed groups. Nothing here can
// re-parent a node — the layout grants nothing.
import { OVERSEER_ROLE, unassignedText, type TeamNode, type TeamTree, type UnassignedNode } from './team';

/** The StateDot four (ui/sidebar-model.ts DotState), repeated here so core stays free of ui/. */
export type NodeDot = 'needs' | 'refused' | 'running' | 'idle';

/** What one card shows. These are the sidebar row's fields (ui/sidebar-model.ts SidebarRow) plus
 *  the role and the isolation chip, from the same grid getters — one source, so the stage and the
 *  sidebar cannot disagree. */
export interface NodeCard {
	key: number;
	name: string;
	/** The role slug the session runs on. Shown as the subline with the isolation chip. */
	role: string;
	/** The branch, or an em dash where there is none. */
	branch: string;
	/** core/isolation.ts modeChip text ('wt', 'ro', …), or null for a session with no mode. */
	isolation: string | null;
	dot: NodeDot;
	/** ★ — set from buildTeam's `manager` (the role file declares `spawns:`), never from children. */
	manager: boolean;
	/** ◆N — open spawn proposals addressed to this session. */
	proposals: number;
	/** Needs attention right now (ui/attention kinds): the badge on the node. */
	attention: 'input' | 'help' | 'done' | null;
}

export interface TreeMetrics {
	cardW: number;
	cardH: number;
	/** Horizontal space between a parent's column and its children's: where the edge elbows. */
	colGap: number;
	rowGap: number;
	pad: number;
	/** Extra space above the UNASSIGNED block, for its label. */
	headerH: number;
}

export const DEFAULT_TREE_METRICS: TreeMetrics = { cardW: 168, cardH: 48, colGap: 28, rowGap: 10, pad: 8, headerH: 22 };

/** The narrowest the tree can be and still draw one card. Below this it is a rail of dots. */
export function minTreeWidth(m: TreeMetrics = DEFAULT_TREE_METRICS): number {
	return m.cardW + 2 * m.pad;
}

export type RootGroup = 'overseer' | 'unassigned';

export interface NodeBox {
	key: number;
	sessionId: string;
	x: number; y: number; w: number; h: number;
	depth: number;
	card: NodeCard;
	group: RootGroup;
	/** Has children in the tree (whether or not they are drawn). */
	hasChildren: boolean;
	/** Collapsed by the viewer: how many sessions below it are not drawn. 0 when expanded. */
	hiddenBelow: number;
	/** An UNASSIGNED root's reason, in the sidebar's words (team.ts unassignedText). */
	reason?: string;
}

/** Why an edge is drawn as unchecked. `overseer`: the overseer spawns through its own channel and
 *  no role check made the spawn (team.ts: "The overseer still SPAWNS through its own channel,
 *  unchecked"). `delegation-off`: `v2.managers` is off, so buildTeam checked no edge at all. */
export type UncheckedWhy = 'overseer' | 'delegation-off';

export const UNCHECKED_TEXT: Record<UncheckedWhy, string> = {
	overseer: 'unchecked — the overseer spawns through its own channel; its role file carries no spawns: key to check against',
	'delegation-off': 'unchecked — manager delegation is off, so no edge is checked against role files',
};

export interface EdgePath {
	from: number;
	to: number;
	/** An SVG path: out of the parent's right edge, an elbow in the column gap, into the child's left. */
	d: string;
	/** Null = the edge was checked by delegation (core/delegation.ts) and survived. */
	unchecked: UncheckedWhy | null;
}

export interface TreeLayout {
	nodes: NodeBox[];
	edges: EdgePath[];
	/** What the whole drawing needs. The stage scrolls vertically when height exceeds it. */
	width: number;
	height: number;
	/** Top of the UNASSIGNED label, or null when nobody is unassigned. */
	unassignedLabelY: number | null;
}

export interface TreeOptions {
	/** sessionIds whose subtrees the viewer collapsed. */
	collapsed?: ReadonlySet<string>;
	/** Whether buildTeam was given a role lookup (`v2.managers` on). Off, no edge was checked. */
	delegationOn?: boolean;
	metrics?: TreeMetrics;
}

const countBelow = (n: TeamNode): number => n.children.reduce((s, c) => s + 1 + countBelow(c), 0);

/** Lay out a built team tree. Every session in the tree is drawn exactly once unless it is below a
 *  collapsed node, in which case the collapsed node says how many it is hiding. `cards` must hold
 *  a card for every key in the tree; a node without one is drawn with its key as its name, so a
 *  missing card can never make a session vanish. */
export function layoutTree(tree: TeamTree, cards: ReadonlyMap<number, NodeCard>, opts: TreeOptions = {}): TreeLayout {
	const m = opts.metrics ?? DEFAULT_TREE_METRICS;
	const collapsed = opts.collapsed ?? new Set<string>();
	const nodes: NodeBox[] = [];
	const edges: EdgePath[] = [];
	let row = 0;          // next free leaf row
	let yBase = m.pad;    // where row 0 starts — moves down past the UNASSIGNED label
	let maxDepth = -1;
	const rowY = (r: number): number => yBase + r * (m.cardH + m.rowGap);
	const colX = (d: number): number => m.pad + d * (m.cardW + m.colGap);

	const cardFor = (n: TeamNode): NodeCard => cards.get(n.session.key) ?? {
		key: n.session.key, name: String(n.session.key), role: n.session.role, branch: '—', isolation: null,
		dot: 'running', manager: n.manager === true, proposals: 0, attention: null,
	};

	/** Place a subtree; returns the y of the node's top. */
	const place = (n: TeamNode, depth: number, group: RootGroup, reason?: string): NodeBox => {
		maxDepth = Math.max(maxDepth, depth);
		const isCollapsed = collapsed.has(n.session.sessionId) && n.children.length > 0;
		const kids = isCollapsed ? [] : n.children.map((c) => place(c, depth + 1, group));
		let y: number;
		if (kids.length === 0) { y = rowY(row); row++; }
		else y = (kids[0]!.y + kids[kids.length - 1]!.y) / 2;
		const box: NodeBox = {
			key: n.session.key, sessionId: n.session.sessionId,
			x: colX(depth), y, w: m.cardW, h: m.cardH, depth,
			// ★ is buildTeam's verdict (from the role file's spawns:), the same one the sidebar shows.
			card: { ...cardFor(n), manager: n.manager === true }, group,
			hasChildren: n.children.length > 0,
			hiddenBelow: isCollapsed ? countBelow(n) : 0,
			...(reason ? { reason } : {}),
		};
		nodes.push(box);
		const overseerParent = n.session.role === OVERSEER_ROLE;
		for (const k of kids) {
			edges.push({
				from: box.key, to: k.key, d: elbow(box, k, m),
				unchecked: overseerParent ? 'overseer' : opts.delegationOn ? null : 'delegation-off',
			});
		}
		return box;
	};

	for (const r of tree.overseers) place(r, 0, 'overseer');
	let unassignedLabelY: number | null = null;
	if (tree.unassigned.length > 0) {
		// The label sits in its own band above the first unassigned root; rows below shift down by it.
		unassignedLabelY = rowY(row);
		yBase += m.headerH;
		for (const u of tree.unassigned) place(u, 0, 'unassigned', unassignedText(u as UnassignedNode));
	}

	// Draw order: parents before children reads best for a screen reader and for hit-testing, and
	// declared order within a level keeps it stable. Sort by depth, then by y.
	nodes.sort((a, b) => a.depth - b.depth || a.y - b.y || a.key - b.key);
	const width = maxDepth < 0 ? 0 : colX(maxDepth) + m.cardW + m.pad;
	const height = row === 0 ? 0 : rowY(row - 1) + m.cardH + m.pad;
	return { nodes, edges, width, height, unassignedLabelY };
}

/** Parent's right-middle → half-way across the gap → down or up → child's left-middle. */
function elbow(p: NodeBox, c: NodeBox, m: TreeMetrics): string {
	const x1 = p.x + p.w, y1 = p.y + p.h / 2;
	const x2 = c.x, y2 = c.y + c.h / 2;
	const mx = x1 + m.colGap / 2;
	return `M${x1} ${y1} H${mx} V${y2} H${x2}`;
}

/** The siblings of a node, in drawn order (top to bottom) — what Alt+←/→ steps through. Roots
 *  count as siblings of each other. */
export function siblingsOf(layout: TreeLayout, key: number): NodeBox[] {
	const parentOf = new Map<number, number>();
	for (const e of layout.edges) parentOf.set(e.to, e.from);
	const p = parentOf.get(key);
	return layout.nodes
		.filter((n) => parentOf.get(n.key) === p)
		.sort((a, b) => a.y - b.y || a.key - b.key);
}

/** The node one step from `key` among its siblings, wrapping; `key` itself when it has none. When
 *  nothing is selected, the first node drawn. */
export function stepSelection(layout: TreeLayout, key: number | null, dir: 1 | -1): number | null {
	if (layout.nodes.length === 0) return null;
	if (key === null || !layout.nodes.some((n) => n.key === key)) return layout.nodes[0]!.key;
	const sibs = siblingsOf(layout, key);
	const i = sibs.findIndex((n) => n.key === key);
	return sibs[(i + dir + sibs.length) % sibs.length]!.key;
}

/** Every drawn node in reading order — depth first, each parent before its children, siblings top
 *  to bottom — the order badges are handed out in, so Alt+F1 is always the first root. */
export function readingOrder(layout: TreeLayout): NodeBox[] {
	const parentOf = new Map<number, number>();
	for (const e of layout.edges) parentOf.set(e.to, e.from);
	const byY = (a: NodeBox, b: NodeBox): number => a.y - b.y || a.key - b.key;
	const kids = (k: number | undefined): NodeBox[] => layout.nodes.filter((n) => parentOf.get(n.key) === k).sort(byY);
	const out: NodeBox[] = [];
	const go = (n: NodeBox): void => { out.push(n); kids(n.key).forEach(go); };
	kids(undefined).forEach(go);
	return out;
}
