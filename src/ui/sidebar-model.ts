// V2 UI step 2 — the sidebar's pure logic. Decides what the sidebar shows (grouping, ordering,
// the roll-up a collapsed group keeps) from state the app already produces: each grid's
// floorState() rows, plus which workspace is active and whether its sessions are loaded. It
// classifies nothing itself — `state` arrives already classified by the grid (the same
// classifyOne precedence the ⚠ queue and the tab markers use) — and it holds nothing between
// calls. The view (sidebar.ts) renders exactly what this returns.
//
// V2 Team Floor step 7 adds the team view (`v2.teamView`, default off): the same rows, nested by
// lineage (src/core/team.ts buildTeam) instead of bucketed by state. Off, nothing below changes.
// Step 10 (`v2.managers`): with a role lookup passed in, a manager row carries ★ (from its role
// file's `spawns:`, never from having children) and an edge its parent could not have made lands
// in UNASSIGNED with the refusal. Still absent: workstreams (step 11).
import { buildTeam, triageTeam, unassignedText, OVERSEER_ROLE, type TeamNode, type TeamSession, type UnassignedNode } from '../core/team';
import type { RoleLookup } from '../core/delegation';

/** floorState()'s id for the overseer console (terminals-grid.ts floorState: `id: -1`). */
export const OVERSEER_ID = -1;

/** The subset of a floorState() row the sidebar reads. */
export interface SidebarSession { id: number; name: string; branch: string; state: string; remoteOn: boolean; }

export interface SidebarWorkspaceInput {
	id: string;
	name: string;
	/** The linked repo, when the workspace has one — shown on the header. */
	repo?: string;
	active: boolean;
	/** False for a workspace whose grid has not restored its sessions yet (never opened this
	 *  launch): its empty session list means "not loaded", not "nothing running". */
	live: boolean;
	sessions: SidebarSession[];
	/** The grid's sessionLineage() — identity, role and parent edge per tile. Read only with the
	 *  team view on. A session with no entry here is still shown, as unassigned. */
	lineage?: SidebarLineage[];
	/** `v2.managers` on: open spawn proposals per addressee sessionId (manager-model
	 *  openProposalCounts) — FR-53's count on the parent's row. Read with the team view only. */
	proposals?: Readonly<Record<string, number>>;
}

/** The subset of a sessionLineage() row the team view reads. */
export interface SidebarLineage { tileId: number; sessionId: string; parentSessionId?: string; role: string; }

/** The four StateDot states (design system, components/StateDot). */
export type DotState = 'needs' | 'refused' | 'running' | 'idle';
export type Bucket = 'needs' | 'running' | 'done';

export interface SidebarRow {
	id: number;
	name: string;
	/** The branch, or an em dash where there is none. Never shortened. */
	branch: string;
	dot: DotState;
	chips: string[];
	overseer: boolean;
	/** ★ — the session's role file declares `spawns:` (team view with `v2.managers` on only). */
	manager: boolean;
	/** Open spawn proposals addressed to this session (◆N). 0 outside the team view. */
	proposals: number;
}

export interface SidebarSection { bucket: Bucket; title: string; rows: SidebarRow[]; }

/** One row of the team tree, flattened in display order. Depth is the only nesting cue. */
export interface TeamLine {
	row: SidebarRow;
	/** 0 = a root (an overseer, or an unassigned session); +1 per level below. */
	depth: number;
	/** Why an UNASSIGNED root is unassigned, in words. Set on unassigned roots only. */
	reason?: string;
}

/** The team view of one workspace: overseer trees pinned first, then UNASSIGNED — always shown
 *  when it has anyone in it, never folded into the trees above. */
export interface SidebarTeam {
	/** Needs-you pinned mode only: every blocked session (needs you or refused), in declared order,
	 *  above the tree. The tree below still shows them in place — the strip is a shortcut, not a
	 *  move. Empty in the other modes. */
	pinned: PinnedLine[];
	tree: TeamLine[];
	unassigned: TeamLine[];
}

/** A pinned-strip row and where it lives in the tree, so the strip never loses the context. */
export interface PinnedLine { row: SidebarRow; context: string; }

/** The team view's three orderings (Lineage · Triage · Needs-you pinned). */
export type TeamSort = 'lineage' | 'triage' | 'pinned';
export const TEAM_SORTS: ReadonlyArray<{ id: TeamSort; label: string; title: string }> = [
	{ id: 'lineage', label: 'Lineage', title: 'Declared order — the order sessions were opened. Rows never move.' },
	{ id: 'triage', label: 'Triage', title: 'Worst state first, within each level. A blocked session pulls its branch up and keeps its parent.' },
	{ id: 'pinned', label: 'Needs-you pinned', title: 'Declared order, with blocked sessions pinned in a strip above. The tree never moves.' },
];

/** A stored sort mode, or Lineage for anything else. */
export function parseTeamSort(v: unknown): TeamSort {
	return v === 'triage' || v === 'pinned' ? v : 'lineage';
}

/** How often positions may change. The classifier ticks every second; re-ranking at that rate
 *  moves a row out from under the pointer as the user reaches for it. Dots still update live —
 *  only ORDER (and pinned-strip membership) waits for the next re-sort. */
export const RESORT_MS = 3000;

/** The key a session's frozen state is stored under in a ResortClock snapshot. */
export const rankKey = (workspaceId: string, tileId: number): string => `${workspaceId}:${tileId}`;

/** Holds the states the order was last computed from, and re-takes them at most every
 *  `interval` ms. Pure: the caller passes the time. */
export class ResortClock {
	private snap: ReadonlyMap<string, DotState> = new Map();
	private at = Number.NEGATIVE_INFINITY;
	constructor(private readonly interval: number = RESORT_MS) {}

	/** The states to ORDER by: the last snapshot, unless `interval` has passed since it was taken. */
	ranks(live: ReadonlyMap<string, DotState>, now: number): ReadonlyMap<string, DotState> {
		if (now - this.at >= this.interval) { this.snap = new Map(live); this.at = now; }
		return this.snap;
	}

	/** Re-sort on the next call — the user changed mode, which is a deliberate reorder. */
	invalidate(): void { this.at = Number.NEGATIVE_INFINITY; }
}

/** Every session's live dot, keyed for a ResortClock. */
export function liveRanks(workspaces: readonly SidebarWorkspaceInput[]): Map<string, DotState> {
	const m = new Map<string, DotState>();
	for (const w of workspaces) for (const s of w.sessions) m.set(rankKey(w.id, s.id), dotFor(s.state));
	return m;
}

export interface SidebarGroup {
	id: string;
	name: string;
	repo?: string;
	active: boolean;
	live: boolean;
	collapsed: boolean;
	/** Overseer rows, pinned above the sections. Empty while collapsed. */
	overseers: SidebarRow[];
	/** Needs you → Running → Done, empty sections omitted. Empty while collapsed. */
	sections: SidebarSection[];
	/** The team view, when it is on: replaces `overseers` and `sections` (both empty then). Null
	 *  with the team view off, or while collapsed. */
	team: SidebarTeam | null;
	/** Worst state across every session in the group, overseer included — kept while collapsed,
	 *  so collapsing never hides that something needs you. Null for an empty group. */
	worst: DotState | null;
	counts: Record<Bucket, number>;
	total: number;
}

const EM_DASH = '—';

/** config.json `v2.sidebar`. Default OFF: only an explicit `true` turns it on, and off is the
 *  app exactly as it was before the sidebar existed. */
export function parseSidebarEnabled(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { sidebar?: unknown }).sidebar === true;
}

/** config.json `v2.teamView`. Default OFF, same rule as `v2.sidebar`: only an explicit `true`.
 *  Off is exactly the flat status order the sidebar shipped with. */
export function parseTeamView(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { teamView?: unknown }).teamView === true;
}

export interface SidebarOptions {
	/** `v2.teamView`: nest by lineage instead of bucketing by state. */
	teamView?: boolean;
	/** The team view's ordering. Default Lineage. */
	sort?: TeamSort;
	/** The states to order by (a ResortClock snapshot, keyed by rankKey). A session missing from
	 *  it — opened since the last re-sort — is ordered by its live state. Default: all live. */
	ranks?: ReadonlyMap<string, DotState>;
	/** `v2.managers` on: the active role files. Marks ★ and checks every edge (core/team.ts). */
	delegation?: RoleLookup;
}

/** Map a classifier state (prompt | menu | errored | idle | running) onto the StateDot four.
 *  Errored is the "wants a human" bucket; it gets the red dot. Anything unrecognised reads as
 *  running — the sidebar must never invent a "needs you" the classifier did not report. */
export function dotFor(state: string): DotState {
	if (state === 'prompt' || state === 'menu') return 'needs';
	if (state === 'errored') return 'refused';
	if (state === 'idle') return 'idle';
	return 'running';
}

const BUCKET_OF: Record<DotState, Bucket> = { needs: 'needs', refused: 'needs', running: 'running', idle: 'done' };
const TITLES: Record<Bucket, string> = { needs: 'Needs you', running: 'Running', done: 'Done' };
const BUCKETS: Bucket[] = ['needs', 'running', 'done'];
/** Lower = worse. The roll-up picks the lowest. */
const SEVERITY: Record<DotState, number> = { needs: 0, refused: 1, running: 2, idle: 3 };
/** Within Needs you: prompt, then menu, then errored — the ⚠ queue's precedence. */
const STATE_RANK: Record<string, number> = { prompt: 0, menu: 1, errored: 2 };

function toRow(s: SidebarSession): SidebarRow {
	const branch = (s.branch ?? '').trim();
	return {
		id: s.id,
		name: s.name,
		branch: branch || EM_DASH,
		dot: dotFor(s.state),
		chips: s.remoteOn ? ['remote'] : [],
		overseer: s.id === OVERSEER_ID,
		manager: false,
		proposals: 0,
	};
}

/** The team view of one workspace's sessions. Every session in `w.sessions` comes out as exactly
 *  one line (buildTeam's invariant); lineage for a tile that is not in `w.sessions` is ignored. */
export function buildTeamView(w: SidebarWorkspaceInput, opts: Pick<SidebarOptions, 'sort' | 'ranks' | 'delegation'> = {}): SidebarTeam {
	const sort = opts.sort ?? 'lineage';
	const rows = new Map<number, SidebarRow>();
	for (const s of w.sessions) rows.set(s.id, toRow(s));
	const rankedDot = (tileId: number): DotState => opts.ranks?.get(rankKey(w.id, tileId)) ?? rows.get(tileId)!.dot;
	const lin = new Map<number, SidebarLineage>();
	for (const l of w.lineage ?? []) lin.set(l.tileId, l);
	const sessions: TeamSession[] = w.sessions.map((s) => {
		const l = lin.get(s.id);
		// No lineage row (should not happen): an id nobody can name as a parent, and no parent —
		// so it lands in UNASSIGNED rather than vanishing. The overseer keeps its pin regardless.
		return {
			key: s.id,
			sessionId: l?.sessionId ?? `tile:${s.id}`,
			role: s.id === OVERSEER_ID ? OVERSEER_ROLE : (l?.role ?? ''),
			...(l?.parentSessionId ? { parentSessionId: l.parentSessionId } : {}),
		};
	});
	const built = buildTeam(sessions, { delegation: opts.delegation });
	// Triage reorders siblings by their branch's worst state; the other two keep declared order.
	const severity = (s: TeamSession): number => SEVERITY[rankedDot(s.key)];
	const overseers = sort === 'triage' ? triageTeam(built.overseers, severity) : built.overseers;
	const unassigned = sort === 'triage' ? triageTeam(built.unassigned, severity) : built.unassigned;

	const pinned: PinnedLine[] = [];
	const flatten = (nodes: readonly TeamNode[], depth: number, out: TeamLine[], context: string, reasonOf?: (n: TeamNode) => string): TeamLine[] => {
		for (const n of nodes) {
			const base = rows.get(n.session.key)!;
			const open = w.proposals?.[n.session.sessionId] ?? 0;
			const row = n.manager || open ? { ...base, manager: n.manager === true, proposals: open } : base;
			const reason = reasonOf?.(n);
			out.push({ row, depth, ...(reason ? { reason } : {}) });
			if (sort === 'pinned' && BUCKET_OF[rankedDot(n.session.key)] === 'needs') pinned.push({ row, context });
			flatten(n.children, depth + 1, out, `under ${row.name}`);
		}
		return out;
	};
	const tree = flatten(overseers, 0, [], 'overseer');
	const rest = flatten(unassigned, 0, [], 'unassigned', (n) => unassignedText(n as UnassignedNode));
	pinned.sort((a, b) => a.row.id - b.row.id);
	return { pinned, tree, unassigned: rest };
}

/** Build every workspace's group. `collapsed` holds the ids of collapsed workspaces. */
export function buildSidebar(workspaces: SidebarWorkspaceInput[], collapsed: ReadonlySet<string>, opts: SidebarOptions = {}): SidebarGroup[] {
	return workspaces.map((w) => {
		const isCollapsed = collapsed.has(w.id);
		const teamOn = opts.teamView === true;
		const counts: Record<Bucket, number> = { needs: 0, running: 0, done: 0 };
		let worst: DotState | null = null;
		const overseers: SidebarRow[] = [];
		const byBucket: Record<Bucket, Array<{ row: SidebarRow; rank: number }>> = { needs: [], running: [], done: [] };

		for (const s of w.sessions) {
			const row = toRow(s);
			const bucket = BUCKET_OF[row.dot];
			counts[bucket]++;
			if (worst === null || SEVERITY[row.dot] < SEVERITY[worst]) worst = row.dot;
			if (row.overseer) overseers.push(row);
			else byBucket[bucket].push({ row, rank: STATE_RANK[s.state] ?? 0 });
		}

		const sections: SidebarSection[] = isCollapsed || teamOn ? [] : BUCKETS
			.filter((b) => byBucket[b].length > 0)
			.map((b) => ({
				bucket: b,
				title: TITLES[b],
				rows: byBucket[b].sort((x, y) => x.rank - y.rank || x.row.id - y.row.id).map((x) => x.row),
			}));

		return {
			id: w.id, name: w.name, repo: w.repo, active: w.active, live: w.live,
			collapsed: isCollapsed,
			overseers: isCollapsed || teamOn ? [] : overseers,
			sections,
			team: teamOn && !isCollapsed ? buildTeamView(w, opts) : null,
			worst, counts,
			total: w.sessions.length,
		};
	});
}

/** A cheap fingerprint of everything the view draws, so it re-renders only when it changed. */
export function sidebarSignature(groups: SidebarGroup[]): string {
	return JSON.stringify(groups);
}

/** The sidebar's one collapse-all / expand-all control. While anything is expanded it collapses
 *  everything; once every group is collapsed it expands them all. */
export function collapseAllAction(groupIds: readonly string[], collapsed: ReadonlySet<string>): 'collapse' | 'expand' {
	return groupIds.some((id) => !collapsed.has(id)) ? 'collapse' : 'expand';
}

/** What `collapsed` becomes when that control is pressed: every rendered group, or none. */
export function applyCollapseAll(groupIds: readonly string[], collapsed: ReadonlySet<string>): Set<string> {
	return collapseAllAction(groupIds, collapsed) === 'collapse' ? new Set(groupIds) : new Set();
}

/** The tab strip's rules for its own affordances, shared with the sidebar so the two can never
 *  disagree. A workspace can be closed only while it is not the last one. */
export function canCloseWorkspace(workspaceCount: number): boolean {
	return workspaceCount > 1;
}

/** The Recently closed button's label, or null to hide it — it hides at zero. */
export function recentlyClosedLabel(closedCount: number): string | null {
	return closedCount > 0 ? `↩ Recently closed (${closedCount})` : null;
}

/** config.json `v2.hideTabs`. Default OFF, same rule as `v2.sidebar`: only an explicit `true`. */
export function parseHideTabs(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { hideTabs?: unknown }).hideTabs === true;
}

/** Whether the tab strip is hidden. `hideTabs` does nothing while the sidebar is off: hiding the
 *  tabs with no sidebar up would leave no way to change workspace at all. This is the only place
 *  that decision is made — the app hides the strip from its result and nothing else. */
export function tabsHidden(opts: { sidebar: boolean; hideTabs: boolean }): boolean {
	return opts.sidebar && opts.hideTabs;
}
