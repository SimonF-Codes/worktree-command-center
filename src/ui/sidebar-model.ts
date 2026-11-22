// V2 UI step 2 — the sidebar's pure logic. Decides what the sidebar shows (grouping, ordering,
// the roll-up a collapsed group keeps) from state the app already produces: each grid's
// floorState() rows, plus which workspace is active and whether its sessions are loaded. It
// classifies nothing itself — `state` arrives already classified by the grid (the same
// classifyOne precedence the ⚠ queue and the tab markers use) — and it holds nothing between
// calls. The view (sidebar.ts) renders exactly what this returns.
//
// V2 Team Floor step 7 adds the team view (`v2.teamView`, default off): the same rows, nested by
// lineage (src/core/team.ts buildTeam) instead of bucketed by state. Off, nothing below changes.
// Still absent: managers and ★ (step 10), workstreams (step 11).
import { buildTeam, OVERSEER_ROLE, UNASSIGNED_TEXT, type TeamNode, type TeamSession, type UnassignedNode } from '../core/team';

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
export interface SidebarTeam { tree: TeamLine[]; unassigned: TeamLine[]; }

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
	};
}

/** The team view of one workspace's sessions. Every session in `w.sessions` comes out as exactly
 *  one line (buildTeam's invariant); lineage for a tile that is not in `w.sessions` is ignored. */
export function buildTeamView(w: SidebarWorkspaceInput): SidebarTeam {
	const rows = new Map<number, SidebarRow>();
	for (const s of w.sessions) rows.set(s.id, toRow(s));
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
	const team = buildTeam(sessions);
	const flatten = (nodes: readonly TeamNode[], depth: number, out: TeamLine[], reasonOf?: (n: TeamNode) => string): TeamLine[] => {
		for (const n of nodes) {
			const reason = reasonOf?.(n);
			out.push({ row: rows.get(n.session.key)!, depth, ...(reason ? { reason } : {}) });
			flatten(n.children, depth + 1, out);
		}
		return out;
	};
	return {
		tree: flatten(team.overseers, 0, []),
		unassigned: flatten(team.unassigned, 0, [], (n) => UNASSIGNED_TEXT[(n as UnassignedNode).reason]),
	};
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
			team: teamOn && !isCollapsed ? buildTeamView(w) : null,
			worst, counts,
			total: w.sessions.length,
		};
	});
}

/** A cheap fingerprint of everything the view draws, so it re-renders only when it changed. */
export function sidebarSignature(groups: SidebarGroup[]): string {
	return JSON.stringify(groups);
}
