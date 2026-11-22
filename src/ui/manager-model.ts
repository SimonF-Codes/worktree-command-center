// V2 Team Floor step 10 — the Manager view's pure logic (design §B, Q4's third option, chosen).
//
// A full-width view of one manager session: what its role file lets it spawn, its team (every
// session below it, through accepted edges), and the spawn proposals addressed to it. It is a
// PRESENTATION. It grants nothing, holds nothing, and cannot drift from the role file: every line
// is recomputed from the same tree the sidebar draws (core/team.ts) and the same role files the
// request channel checks against. Nothing here accepts, declines, spawns or tells — the view shows
// the command the manager itself would run, because the manager is the one with the authority.
//
// No IO: the caller hands in the floor, the role lookup and the folded proposals.

import { checkDelegationBySlug, isManager, rungIndex, RUNGS, type RoleLookup } from '../core/delegation';
import { effectiveState, type SpawnProposal } from '../core/proposals';
import { floorTree, type FloorSession } from '../core/session-requests';
import { findNode, placedParentOf, type TeamNode } from '../core/team';
import { dotFor, type DotState } from './sidebar-model';

/** A floor session plus what the classifier says about it. */
export interface ManagerFloorSession extends FloorSession { state: string; branch: string }

export interface ManagerViewInput {
	managerSessionId: string;
	/** Shown when the session is gone, so the header still says whose view this was. */
	lastKnownName: string;
	sessions: readonly ManagerFloorSession[];
	lookup: RoleLookup;
	proposals: readonly SpawnProposal[];
}

export interface TeamRow {
	key: number; name: string; role: string; branch: string; dot: DotState; depth: number;
	manager: boolean; workstreamId?: string;
}

export interface ProposalRow {
	id: string; from: string; role: string; task: string; why: string; ts: number;
	/** Written while its proposer was unassigned — any manager may take it. */
	unaddressed: boolean;
	/** Would accepting it pass checkDelegation for THIS manager? A preview; the accept re-checks. */
	verdict: { ok: true } | { ok: false; reason: string };
	acceptCommand: string;
	declineCommand: string;
}

export interface DecidedRow { id: string; from: string; role: string; task: string; state: SpawnProposal['state']; reason?: string; by?: string }

export interface ManagerView {
	/** The session is no longer on the floor: the view reads vacant rather than closing under you. */
	vacant: boolean;
	name: string;
	role: string;
	/** `authority:` as the role file has it, and whether it is one of the four rungs. */
	authority: string;
	rungKnown: boolean;
	/** The role file's spawns:. Empty means not (or no longer) a manager. */
	spawns: string[];
	manager: boolean;
	/** Where the manager itself sits: under whom, or unassigned / overseer. */
	placement: string;
	team: TeamRow[];
	open: ProposalRow[];
	/** The most recent decided or stale proposals addressed to it, newest first. */
	decided: DecidedRow[];
}

/** How many decided proposals the view keeps on screen. */
export const DECIDED_SHOWN = 10;

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/** Build the view. Same inputs, same view. */
export function buildManagerView(input: ManagerViewInput): ManagerView {
	const me = input.sessions.find((s) => s.sessionId === input.managerSessionId);
	const roleSlug = me?.role ?? '';
	const role = me ? input.lookup(me.role) : undefined;
	const tree = floorTree(input.sessions, input.lookup);
	const byId = new Map(input.sessions.map((s) => [s.sessionId, s]));
	const live = new Set(input.sessions.map((s) => s.sessionId));

	const team: TeamRow[] = [];
	const node = me ? findNode(tree, me.sessionId) : undefined;
	const walk = (n: TeamNode, depth: number): void => {
		for (const c of n.children) {
			const s = byId.get(c.session.sessionId)!;
			team.push({
				key: s.key, name: s.name, role: s.role, branch: s.branch.trim() || '—', dot: dotFor(s.state), depth,
				manager: c.manager === true, ...(s.workstreamId ? { workstreamId: s.workstreamId } : {}),
			});
			walk(c, depth + 1);
		}
	};
	if (node) walk(node, 0);

	const mine = me ? input.proposals.filter((p) => p.to === me.sessionId || (p.to === null && isManager(role))) : [];
	const open: ProposalRow[] = mine
		.filter((p) => effectiveState(p, live) === 'open')
		.map((p) => {
			const v = checkDelegationBySlug(input.lookup, roleSlug, p.role);
			return {
				id: p.id, from: p.from.name, role: p.role, task: p.task, why: p.why, ts: p.ts, unaddressed: p.to === null,
				verdict: v.ok ? { ok: true as const } : { ok: false as const, reason: v.reason },
				acceptCommand: `cos-coord proposal accept ${p.id}`,
				declineCommand: `cos-coord proposal decline ${p.id} --reason ${quote('…')}`,
			};
		});
	const decided: DecidedRow[] = mine
		.filter((p) => effectiveState(p, live) !== 'open')
		.sort((a, b) => (b.decidedTs ?? b.ts) - (a.decidedTs ?? a.ts))
		.slice(0, DECIDED_SHOWN)
		.map((p) => {
			const state = effectiveState(p, live);
			const reason = p.reason ?? (state === 'stale' && p.state === 'open' ? `${p.from.name} has ended` : undefined);
			const by = p.decidedByName ?? (p.decidedBy ? byId.get(p.decidedBy)?.name ?? p.decidedBy : undefined);
			return { id: p.id, from: p.from.name, role: p.role, task: p.task, state, ...(reason ? { reason } : {}), ...(by ? { by } : {}) };
		});

	let placement = 'not on the floor';
	if (me) {
		const parent = placedParentOf(tree, me.sessionId);
		const un = tree.unassigned.find((u) => u.session.sessionId === me.sessionId);
		placement = parent ? `under ${byId.get(parent.sessionId)?.name ?? parent.sessionId}`
			: un ? `unassigned — ${un.detail ?? un.reason}`
			: 'an overseer';
	}

	const authority = role?.authority ?? '';
	return {
		vacant: !me,
		name: me?.name ?? input.lastKnownName,
		role: roleSlug,
		authority: authority || '(no active role file)',
		rungKnown: rungIndex(authority) >= 0,
		spawns: role ? [...role.spawns] : [],
		manager: isManager(role),
		placement,
		team, open, decided,
	};
}

/** The ladder, for the authority chip's tooltip. */
export const LADDER_TEXT = RUNGS.join(' < ');

/** Open proposals per addressee — FR-53's count on the parent's sidebar row. Unaddressed ones are
 *  not counted against anyone: they belong to no row. */
export function openProposalCounts(proposals: readonly SpawnProposal[], liveSessionIds: ReadonlySet<string>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of proposals) {
		if (p.to && effectiveState(p, liveSessionIds) === 'open') out[p.to] = (out[p.to] ?? 0) + 1;
	}
	return out;
}

/** Cheap fingerprint so the view re-renders only when something it draws changed. */
export function managerViewSignature(v: ManagerView): string { return JSON.stringify(v); }
