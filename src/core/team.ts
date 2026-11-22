// V2 Team Floor step 7 — the team tree. Pure: no window, no fs, no clock. Same sessions in, same
// tree out.
//
// The tree is built from PERSISTED data only (design §3, "Team hierarchy from role files, never
// from layout"): each session's sessionId and parentSessionId (lineage.ts, step 6) and the role it
// runs on. Nothing here looks at where a tile sits on the stage or what order the user dragged
// things into.
//
//   session → role alpha?                         → an overseer root, pinned first
//           → parent set, alive, and reachable?    → a child of that parent
//           → otherwise                            → UNASSIGNED, with the reason
//
// UNASSIGNED is a first-class group: every session handed in comes back out exactly once. A tree
// that silently drops the rows it cannot place looks complete and is not.
//
// Deliberately absent (later steps): `spawns:` and checkDelegation (step 10 — an edge is not yet
// checked against what the parent may spawn), the ★ manager mark, and workstreams (step 11 — so a
// dead parent's children land in UNASSIGNED here rather than under a vacant workstream).

/** The role the overseer runs on (god-console.ts loads the vault's `alpha` role file). */
export const OVERSEER_ROLE = 'alpha';

export interface TeamSession {
	/** The caller's handle for the row (the grid's tile id). Also the declared order: lower first.
	 *  Tile ids are issued in the order sessions are opened, so ascending key is opening order. */
	key: number;
	/** lineage.ts sessionId — what a child's parentSessionId points at. */
	sessionId: string;
	parentSessionId?: string;
	/** The role slug the session runs on. Read for display and for the overseer test only. */
	role: string;
}

/** Why a session could not be placed under a parent. */
export type UnassignedReason = 'no-parent' | 'parent-closed' | 'self-parent' | 'cycle';

export const UNASSIGNED_TEXT: Record<UnassignedReason, string> = {
	'no-parent': 'no parent — opened by hand',
	'parent-closed': 'parent session is closed',
	'self-parent': 'lists itself as its parent',
	cycle: 'lineage loops back on itself',
};

export interface TeamNode {
	session: TeamSession;
	/** In declared order (ascending key). Sorting is a view concern — see sortTeam. */
	children: TeamNode[];
}

export interface UnassignedNode extends TeamNode { reason: UnassignedReason }

export interface TeamTree {
	/** Role-alpha sessions, each with the sessions it spawned beneath it. Declared order. */
	overseers: TeamNode[];
	/** Everything with no live parent to sit under — never empty because of a filter, only
	 *  because every session was placed. Declared order. */
	unassigned: UnassignedNode[];
}

const byKey = (a: TeamNode, b: TeamNode): number => a.session.key - b.session.key;

/** Place every session. Each input session appears exactly once in the result. */
export function buildTeam(sessions: readonly TeamSession[]): TeamTree {
	// Duplicate sessionIds should not exist; if they do, the first (lowest key) owns the id and the
	// others are still placed — they just cannot be anyone's parent.
	const ordered = [...sessions].sort((a, b) => a.key - b.key);
	const nodes = new Map<TeamSession, TeamNode>();
	const owner = new Map<string, TeamSession>();
	for (const s of ordered) {
		nodes.set(s, { session: s, children: [] });
		if (!owner.has(s.sessionId)) owner.set(s.sessionId, s);
	}

	const isOverseer = (s: TeamSession): boolean => s.role === OVERSEER_ROLE;
	const parentOf = (s: TeamSession): TeamSession | undefined => {
		if (isOverseer(s) || !s.parentSessionId) return undefined;
		const p = owner.get(s.parentSessionId);
		return p && p !== s ? p : undefined;
	};

	const overseers: TeamNode[] = [];
	const unassigned: UnassignedNode[] = [];
	const unplaced = new Set<TeamSession>();
	for (const s of ordered) {
		const n = nodes.get(s)!;
		if (isOverseer(s)) { overseers.push(n); continue; }
		const p = parentOf(s);
		if (p) { nodes.get(p)!.children.push(n); unplaced.add(s); continue; }
		const reason: UnassignedReason = !s.parentSessionId ? 'no-parent'
			: owner.get(s.parentSessionId) === s ? 'self-parent'
			: 'parent-closed';
		unassigned.push(Object.assign(n, { reason }));
	}

	// A child counts as placed only if its chain reaches a root. Anything left is in a loop
	// (A → B → A): cut each loop at its first-opened member, which becomes an unassigned root
	// carrying the rest of the loop beneath it.
	const markReached = (n: TeamNode): void => { unplaced.delete(n.session); n.children.forEach(markReached); };
	overseers.forEach(markReached);
	unassigned.forEach(markReached);
	while (unplaced.size > 0) {
		const s = [...unplaced].sort((a, b) => a.key - b.key)[0]!;
		const p = parentOf(s)!;
		const pn = nodes.get(p)!;
		pn.children = pn.children.filter((c) => c.session !== s);
		const root: UnassignedNode = Object.assign(nodes.get(s)!, { reason: 'cycle' as const });
		unassigned.push(root);
		markReached(root);
	}

	// Keep every level in declared order.
	const tidy = (n: TeamNode): void => { n.children.sort(byKey); n.children.forEach(tidy); };
	overseers.forEach(tidy);
	unassigned.forEach(tidy);
	unassigned.sort(byKey);
	return { overseers, unassigned };
}
