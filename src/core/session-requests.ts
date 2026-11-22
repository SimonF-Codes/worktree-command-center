// V2 Team Floor step 10 — the per-session request channel's decisions. Pure: no window, no fs, no
// clock, and NO environment.
//
// A manager acts by dropping a request into `<coordDir>/sessions/<sessionId>/requests/`. Identity
// is THE DIRECTORY the request was dropped in — the connector channel's model (docs/api.md), with
// a session where a connector was. The role behind that identity is the one on the app's own
// session record, and what that role may do is what its role file says (core/delegation.ts).
// Nothing here reads COS_ROLE, or anything else a process could set for itself: worker tiles once
// inherited COS_ROLE=god and all ran with god authority. A manager is never given the overseer's
// god role, and this channel has no god to give.
//
// The verbs a session gets, and why each is bounded:
//   spawn   — checkDelegation(requester's role, child role), in full. The child is the requester's.
//   tell    — only into the requester's own descendants, through accepted edges.
//   assign  — take an UNASSIGNED session (or move one within its own team) under the requester,
//             checked by the same function. Dragging a row never re-parents; this is the only way.
//   close stays the overseer's alone in V2: closing parks work and ends a turn.
//
// Spawn proposals (propose-spawn, proposal-accept, proposal-decline) ride the same channel and are
// decided in core/proposals.ts.

import { EFFORT_LEVELS } from '../terminals/god';
import { sessionRoleSlug } from '../terminals/role-library';
import { checkDelegationBySlug, isManager, MANAGERS_OFF_REASON, type RoleLookup } from './delegation';
import { buildTeam, descendantsOf, findNode, isUnassignedRoot, placedParentOf, OVERSEER_ROLE, type TeamTree } from './team';

/** The same cap the connector channel puts on a `tell` (connectors.ts MAX_TELL_MESSAGE_LEN): a
 *  paste-expanded message has jammed a terminal's input before. Not imported, because that module
 *  pulls in the new-tab IO; a test holds the two equal. */
export const MAX_SESSION_MESSAGE_LEN = 4000;
/** Task / why / reason bounds for the request kinds that carry prose. */
export const MAX_SESSION_TEXT_LEN = 8000;

interface Envelope { v: number; id: string; sentMs: number }
export type SessionSpawnRequest = Envelope & {
	kind: 'spawn'; repo: string; base: string | null; task: string;
	model: string | null; effort: string | null; name: string | null; role: string | null; workstream: string | null;
	/** Isolation intent (`--class / --writes / --isolation`), raw — decideIsolation validates it. */
	taskClass: string | null; writes: string | null; isolation: string | null;
};
export type SessionTellRequest = Envelope & { kind: 'tell'; terminal: string; message: string };
export type SessionAssignRequest = Envelope & { kind: 'assign'; terminal: string };
export type ProposeSpawnRequest = Envelope & { kind: 'propose-spawn'; role: string; task: string; why: string };
export type ProposalAcceptRequest = Envelope & { kind: 'proposal-accept'; proposal: string; repo: string | null; base: string | null };
export type ProposalDeclineRequest = Envelope & { kind: 'proposal-decline'; proposal: string; reason: string };
export type SessionRequest =
	| SessionSpawnRequest | SessionTellRequest | SessionAssignRequest
	| ProposeSpawnRequest | ProposalAcceptRequest | ProposalDeclineRequest;

export const SESSION_REQUEST_KINDS = ['spawn', 'tell', 'assign', 'propose-spawn', 'proposal-accept', 'proposal-decline'] as const;

export type ParsedSessionRequest =
	| { ok: true; request: SessionRequest }
	| { ok: false; id: string | null; reason: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parse one request file. Like the connector parser, it recovers an `id` first wherever it can, so
 *  a malformed request still gets a rejected receipt instead of vanishing. */
export function parseSessionRequest(text: string): ParsedSessionRequest {
	let o: Record<string, unknown>;
	try {
		const p: unknown = JSON.parse(text);
		if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, id: null, reason: 'malformed request — not a JSON object' };
		o = p as Record<string, unknown>;
	} catch {
		return { ok: false, id: null, reason: 'malformed request — invalid JSON' };
	}
	const id = str(o.id);
	if (!id) return { ok: false, id: null, reason: 'malformed request — missing "id"' };
	if (typeof o.v !== 'number') return { ok: false, id, reason: 'malformed request — missing "v"' };
	if (typeof o.sentMs !== 'number') return { ok: false, id, reason: 'malformed request — missing "sentMs"' };
	const env: Envelope = { v: o.v, id, sentMs: o.sentMs };
	const kind = typeof o.kind === 'string' ? o.kind : '';
	const tooLong = (field: string, v: string, max: number): ParsedSessionRequest | null =>
		v.length > max ? { ok: false, id, reason: `${field} is too long (${v.length} chars, max ${max}) — trim it before sending` } : null;
	switch (kind) {
		case 'spawn': {
			const repo = str(o.repo);
			const task = typeof o.task === 'string' && o.task.trim() ? o.task : null;
			if (!repo || !task) return { ok: false, id, reason: 'malformed spawn request — "repo" and "task" are required' };
			const long = tooLong('task', task, MAX_SESSION_TEXT_LEN); if (long) return long;
			const effort = str(o.effort);
			return { ok: true, request: { ...env, kind, repo, task, base: str(o.base), model: str(o.model), effort: effort ? effort.toLowerCase() : null, name: str(o.name), role: str(o.role), workstream: str(o.workstream), taskClass: str(o.taskClass), writes: str(o.writes), isolation: str(o.isolation) } };
		}
		case 'tell': {
			const terminal = str(o.terminal);
			const message = typeof o.message === 'string' && o.message ? o.message : null;
			if (!terminal || !message) return { ok: false, id, reason: 'malformed tell request — "terminal" and "message" are required' };
			const long = tooLong('message', message, MAX_SESSION_MESSAGE_LEN); if (long) return long;
			return { ok: true, request: { ...env, kind, terminal, message } };
		}
		case 'assign': {
			const terminal = str(o.terminal);
			if (!terminal) return { ok: false, id, reason: 'malformed assign request — "terminal" is required' };
			return { ok: true, request: { ...env, kind, terminal } };
		}
		case 'propose-spawn': {
			const role = str(o.role), task = str(o.task), why = str(o.why);
			if (!role || !task || !why) return { ok: false, id, reason: 'malformed propose-spawn request — "role", "task" and "why" are all required' };
			const long = tooLong('task', task, MAX_SESSION_TEXT_LEN) ?? tooLong('why', why, MAX_SESSION_TEXT_LEN); if (long) return long;
			return { ok: true, request: { ...env, kind, role: role.toLowerCase(), task, why } };
		}
		case 'proposal-accept': {
			const proposal = str(o.proposal);
			if (!proposal) return { ok: false, id, reason: 'malformed proposal-accept request — "proposal" is required' };
			return { ok: true, request: { ...env, kind, proposal, repo: str(o.repo), base: str(o.base) } };
		}
		case 'proposal-decline': {
			const proposal = str(o.proposal), reason = str(o.reason);
			if (!proposal || !reason) return { ok: false, id, reason: 'malformed proposal-decline request — "proposal" and "reason" are required: a decline the proposer cannot read the reason for is a dead end' };
			const long = tooLong('reason', reason, MAX_SESSION_TEXT_LEN); if (long) return long;
			return { ok: true, request: { ...env, kind, proposal, reason } };
		}
		default:
			return { ok: false, id, reason: `kind "${kind || '(missing)'}" is not permitted for a session — only ${SESSION_REQUEST_KINDS.join(', ')} (close stays the overseer's)` };
	}
}

/** One live session on the floor, as the channel sees it — the app's own record, never the env. */
export interface FloorSession {
	/** Declared order (the grid's tile id; -1 for the overseer console). */
	key: number;
	sessionId: string;
	parentSessionId?: string;
	/** The role slug on the session's record. */
	role: string;
	name: string;
	/** The target the session works in, when it has one — the default repo for an accepted proposal. */
	repoName?: string;
	/** The workstream it serves — carried onto a proposal it writes. */
	workstreamId?: string;
	journal?: boolean;
}

export interface FloorRepo { name: string; folder?: boolean }

export interface SessionContext {
	/** `v2.managers`. */
	enabled: boolean;
	/** The directory the request came from. */
	requesterId: string;
	sessions: readonly FloorSession[];
	lookup: RoleLookup;
	repos: readonly FloorRepo[];
}

/** The floor as a team tree, delegation on — the same tree the sidebar draws. */
export function floorTree(sessions: readonly FloorSession[], lookup: RoleLookup): TeamTree {
	return buildTeam(sessions.filter((s) => !s.journal).map((s) => ({
		key: s.key, sessionId: s.sessionId, role: s.role, ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
	})), { delegation: lookup });
}

export type Refusal = { ok: false; reason: string };
export type SpawnPlan = {
	ok: true; action: 'spawn'; repo: string; base: string | null; task: string;
	model: string | null; effort: string | null; name: string | null;
	/** The role as requested (null = the target's default); the grid's role loader resolves it. */
	roleSlug: string | null; childRole: string; parentSessionId: string; workstreamId: string | null;
	taskClass: string | null; writes: string | null; isolation: string | null;
};
export type SessionDecision =
	| Refusal
	| SpawnPlan
	| { ok: true; action: 'tell'; terminal: string; message: string }
	| { ok: true; action: 'assign'; targetSessionId: string; terminal: string; parentSessionId: string };

/** Resolve a terminal by name the way the connector channel does: exact first, then a UNIQUE
 *  case-insensitive match. An ambiguous pick is a refusal, never a guess. */
export function resolveSession(name: string, sessions: readonly FloorSession[]): { ok: true; session: FloorSession } | Refusal {
	const exact = sessions.find((s) => s.name === name);
	const pick = exact ?? (() => {
		const m = sessions.filter((s) => s.name.toLowerCase() === name.toLowerCase());
		return m.length === 1 ? m[0] : m.length > 1 ? null : undefined;
	})();
	if (pick === null) return { ok: false, reason: `"${name}" is ambiguous — matches ${sessions.filter((s) => s.name.toLowerCase() === name.toLowerCase()).map((s) => s.name).join(', ')}` };
	if (!pick) return { ok: false, reason: `no such terminal "${name}". Live: ${sessions.filter((s) => !s.journal).map((s) => s.name).join(', ') || '(none)'}` };
	if (pick.journal) return { ok: false, reason: `"${pick.name}" is a journal tile, not a session` };
	return { ok: true, session: pick };
}

/** Who a session is, for a refusal that has to say where something sits. */
function whereIs(tree: TeamTree, sessions: readonly FloorSession[], sessionId: string): string {
	const p = placedParentOf(tree, sessionId);
	if (p) return `it sits under ${sessions.find((s) => s.sessionId === p.sessionId)?.name ?? p.sessionId}`;
	return isUnassignedRoot(tree, sessionId) ? 'it is unassigned' : 'it is an overseer';
}

/** The requester, if the directory belongs to a live session. */
export function requesterOf(ctx: Pick<SessionContext, 'requesterId' | 'sessions'>): FloorSession | undefined {
	return ctx.sessions.find((s) => s.sessionId === ctx.requesterId && !s.journal);
}

/** spawn / tell / assign. The whole accept-or-refuse decision; the caller carries it out. */
export function evaluateSessionRequest(req: SessionSpawnRequest | SessionTellRequest | SessionAssignRequest, ctx: SessionContext): SessionDecision {
	if (!ctx.enabled) return { ok: false, reason: MANAGERS_OFF_REASON };
	const me = requesterOf(ctx);
	if (!me) return { ok: false, reason: `no live session owns this request directory (${ctx.requesterId}) — a request is acted on only for the session whose directory it was dropped in` };

	if (req.kind === 'spawn') {
		const repo = ctx.repos.find((r) => r.name === req.repo) ?? ctx.repos.find((r) => r.name.toLowerCase() === req.repo.toLowerCase());
		if (!repo) return { ok: false, reason: `unknown repo "${req.repo}". Known: ${ctx.repos.map((r) => r.name).join(', ') || '(none)'}` };
		if (req.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(req.effort)) return { ok: false, reason: `invalid effort "${req.effort}". Valid: ${EFFORT_LEVELS.join(', ')}` };
		const childRole = sessionRoleSlug(req.role ?? undefined, repo.folder);
		const d = checkDelegationBySlug(ctx.lookup, me.role, childRole);
		if (!d.ok) return { ok: false, reason: d.reason };
		return {
			ok: true, action: 'spawn', repo: repo.name, base: req.base, task: req.task, model: req.model, effort: req.effort, name: req.name,
			roleSlug: req.role, childRole, parentSessionId: me.sessionId, workstreamId: req.workstream,
			taskClass: req.taskClass, writes: req.writes, isolation: req.isolation,
		};
	}

	// tell and assign: only a manager acts on other sessions at all (Charter §Delegation).
	if (!isManager(ctx.lookup(me.role))) {
		return { ok: false, reason: `${me.name} (${me.role}) has no spawns: in its role file, so the app refuses it any ${req.kind}` };
	}
	const target = resolveSession(req.terminal, ctx.sessions);
	if (!target.ok) return target;
	const t = target.session;
	const tree = floorTree(ctx.sessions, ctx.lookup);
	const mine = findNode(tree, me.sessionId);
	const team = new Set(mine ? descendantsOf(mine).map((s) => s.sessionId) : []);

	if (req.kind === 'tell') {
		if (!team.has(t.sessionId)) {
			return { ok: false, reason: `tell to "${t.name}" refused — a manager's tell reaches only its own descendants, and "${t.name}" is not one of ${me.name}'s (${whereIs(tree, ctx.sessions, t.sessionId)})` };
		}
		return { ok: true, action: 'tell', terminal: t.name, message: req.message };
	}

	// assign
	if (t.sessionId === me.sessionId) return { ok: false, reason: `${me.name} cannot assign itself` };
	if (t.role === OVERSEER_ROLE) return { ok: false, reason: `"${t.name}" is an overseer — it sits under nobody` };
	const targetNode = findNode(tree, t.sessionId);
	if (targetNode && descendantsOf(targetNode).some((s) => s.sessionId === me.sessionId)) {
		return { ok: false, reason: `assign "${t.name}" refused — ${me.name} is below it, so the move would make a loop` };
	}
	if (!team.has(t.sessionId) && !isUnassignedRoot(tree, t.sessionId)) {
		return { ok: false, reason: `assign "${t.name}" refused — a manager takes only an unassigned session or moves one within its own team, and ${whereIs(tree, ctx.sessions, t.sessionId)}` };
	}
	const d = checkDelegationBySlug(ctx.lookup, me.role, t.role);
	if (!d.ok) return { ok: false, reason: `assign "${t.name}" refused — ${d.reason}` };
	return { ok: true, action: 'assign', targetSessionId: t.sessionId, terminal: t.name, parentSessionId: me.sessionId };
}
