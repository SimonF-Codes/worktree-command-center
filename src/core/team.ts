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
// Step 10 (`v2.managers`, passed in as `delegation`): every edge below a non-overseer parent is
// checked by core/delegation.ts checkDelegation against the two sessions' ROLE FILES. An edge the
// parent could not have made confers nothing — the child lands in UNASSIGNED with the refusal as
// its reason. The ★ manager mark comes from `spawns:` alone: a manager with no children keeps it,
// and a session with children it was not permitted to spawn never gets one. Edges FROM the
// overseer are not checked: it spawns through its own channel, which this step leaves exactly as
// it was (Alpha's role file has no `spawns:` yet, and giving it one is the Custodian's call).
//
// Deliberately absent (step 11): workstreams — so a dead parent's children land in UNASSIGNED here
// rather than under a vacant workstream.
import { checkDelegationBySlug, isManager, type RoleLookup } from './delegation';

/** The role the overseer runs on (god-console.ts loads the vault's `alpha` role file). */
export const OVERSEER_ROLE = 'alpha';

export interface TeamSession {
	/** The caller's handle for the row (the grid's tile id). Also the declared order: lower first.
	 *  Tile ids are issued in the order sessions are opened, so ascending key is opening order. */
	key: number;
	/** lineage.ts sessionId — what a child's parentSessionId points at. */
	sessionId: string;
	parentSessionId?: string;
	/** The role slug the session runs on: the overseer test, and (with delegation on) the role file
	 *  its edges and its ★ are checked against. */
	role: string;
}

/** Why a session could not be placed under a parent. */
export type UnassignedReason = 'no-parent' | 'parent-closed' | 'self-parent' | 'cycle' | 'outside-delegation';

export const UNASSIGNED_TEXT: Record<UnassignedReason, string> = {
	'no-parent': 'no parent — opened by hand',
	'parent-closed': 'parent session is closed',
	'self-parent': 'lists itself as its parent',
	cycle: 'lineage loops back on itself',
	'outside-delegation': 'outside delegation',
};

export interface TeamNode {
	session: TeamSession;
	/** In declared order (ascending key). Sorting is a view concern — see sortTeam. */
	children: TeamNode[];
	/** ★ — the session's role file declares `spawns:`. Set only with delegation on. */
	manager?: true;
}

export interface UnassignedNode extends TeamNode {
	reason: UnassignedReason;
	/** 'outside-delegation' only: checkDelegation's refusal, which names the condition that failed. */
	detail?: string;
}

export interface TeamOptions {
	/** `v2.managers` on: the ACTIVE role files, by slug. Absent = step 7's tree, unchecked, unmarked. */
	delegation?: RoleLookup;
}

/** The words for an unassigned node's reason, with the delegation refusal when there is one. */
export function unassignedText(n: UnassignedNode): string {
	return n.detail ? `${UNASSIGNED_TEXT[n.reason]}: ${n.detail}` : UNASSIGNED_TEXT[n.reason];
}

export interface TeamTree {
	/** Role-alpha sessions, each with the sessions it spawned beneath it. Declared order. */
	overseers: TeamNode[];
	/** Everything with no live parent to sit under — never empty because of a filter, only
	 *  because every session was placed. Declared order. */
	unassigned: UnassignedNode[];
}

const byKey = (a: TeamNode, b: TeamNode): number => a.session.key - b.session.key;

/** Place every session. Each input session appears exactly once in the result. */
export function buildTeam(sessions: readonly TeamSession[], opts: TeamOptions = {}): TeamTree {
	// Duplicate sessionIds should not exist; if they do, the first (lowest key) owns the id and the
	// others are still placed — they just cannot be anyone's parent.
	const ordered = [...sessions].sort((a, b) => a.key - b.key);
	const nodes = new Map<TeamSession, TeamNode>();
	const owner = new Map<string, TeamSession>();
	const lookup = opts.delegation;
	for (const s of ordered) {
		nodes.set(s, { session: s, children: [], ...(lookup && isManager(lookup(s.role)) ? { manager: true as const } : {}) });
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
		// An invalid edge confers nothing: the child is unassigned, with the refusal as the reason.
		const edge = p && lookup && !isOverseer(p) ? checkDelegationBySlug(lookup, p.role, s.role) : null;
		if (edge && !edge.ok) { unassigned.push(Object.assign(n, { reason: 'outside-delegation' as const, detail: edge.reason })); continue; }
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

// ---- Reading a built tree. The tree only holds edges that were accepted, so "below" here already
// means "through edges the parent was permitted to make" — an invalid edge confers nothing.

/** Every node, depth-first, roots in order (overseers, then unassigned). */
function walkTree(tree: TeamTree, visit: (n: TeamNode, parent: TeamNode | null) => void): void {
	const go = (n: TeamNode, parent: TeamNode | null): void => { visit(n, parent); for (const c of n.children) go(c, n); };
	for (const r of [...tree.overseers, ...tree.unassigned]) go(r, null);
}

/** The node a sessionId was placed as, or undefined when no session in the tree has it. */
export function findNode(tree: TeamTree, sessionId: string): TeamNode | undefined {
	let found: TeamNode | undefined;
	walkTree(tree, (n) => { if (!found && n.session.sessionId === sessionId) found = n; });
	return found;
}

/** The session this one sits under in the tree — null for a root (an overseer or UNASSIGNED). */
export function placedParentOf(tree: TeamTree, sessionId: string): TeamSession | null {
	let parent: TeamSession | null = null;
	let seen = false;
	walkTree(tree, (n, p) => { if (!seen && n.session.sessionId === sessionId) { seen = true; parent = p?.session ?? null; } });
	return parent;
}

/** Every session below a node, depth-first in declared order. Not the node itself. */
export function descendantsOf(n: TeamNode): TeamSession[] {
	const out: TeamSession[] = [];
	const go = (x: TeamNode): void => { for (const c of x.children) { out.push(c.session); go(c); } };
	go(n);
	return out;
}

/** Is `sessionId` an unassigned ROOT — a session with no accepted parent? */
export function isUnassignedRoot(tree: TeamTree, sessionId: string): boolean {
	return tree.unassigned.some((u) => u.session.sessionId === sessionId);
}

// ---- Ordering. Presentation only: a sort reorders siblings within one level. It never moves a
// node to another parent and never flattens the tree — the flattened sort was the rejected
// prototype (P3), rejected because it destroys the one thing the tree encodes.

/** Lower = worse. The caller maps its own states onto these numbers. */
export type Severity = number;

/** Triage: at every level, siblings ordered by the worst severity anywhere in their branch,
 *  ties in declared order (key). So a blocked leaf pulls its whole branch up with it, the leaf
 *  keeps its parent, and two branches in the same state never swap. Returns new nodes; the
 *  input tree is not touched. */
export function triageTeam<T extends TeamNode>(nodes: readonly T[], severity: (s: TeamSession) => Severity): T[] {
	const memo = new Map<TeamNode, Severity>();
	const worst = (n: TeamNode): Severity => {
		let w = memo.get(n);
		if (w === undefined) {
			w = severity(n.session);
			for (const c of n.children) w = Math.min(w, worst(c));
			memo.set(n, w);
		}
		return w;
	};
	const sortLevel = <N extends TeamNode>(level: readonly N[]): N[] => [...level]
		.sort((a, b) => worst(a) - worst(b) || a.session.key - b.session.key)
		.map((n) => ({ ...n, children: sortLevel(n.children) }));
	return sortLevel(nodes);
}
