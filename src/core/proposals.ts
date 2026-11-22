// V2 Team Floor step 10 — spawn proposals (FR-51..54). Pure: no window, no fs, no clock, no env.
//
// A session whose role has no `spawns:` may still PROPOSE one upward: "this task splits; a
// researcher could take that part". The property that makes it safe, and it is the whole design:
//
//   A PROPOSAL CHANGES WHAT THE ORCHESTRATOR IS ASKED, NEVER WHAT IT MAY DO.
//
// The record is inert. Accepting one builds the very spawn request the parent could have sent
// itself and runs it through evaluateSessionRequest — the same function, so checkDelegation runs in
// full and a worker proposing a role its parent may not spawn gets the identical refusal.
//
// The four rules that keep it from becoming noise:
//   1. At most three open proposals per session; a fourth is refused, naming the open ones (this
//      is also what stops a proposal loop).
//   2. A declined proposal is not re-proposed: the same role + task from the same session is
//      refused with the decline's reason attached.
//   3. Proposals go stale with their proposer (staleOnEnd, written when its session ends).
//   4. The orchestrator is never obliged: nothing here escalates or times out into a spawn.
//      Ignoring a proposal is a legitimate outcome, and there is no code path that acts on one
//      without a decision.

import { proposalKey, type SpawnProposal } from '../../pty-sidecar/proposals-core.cjs';
import { isManager, MANAGERS_OFF_REASON } from './delegation';
import {
	evaluateSessionRequest, floorTree, requesterOf,
	type ProposalAcceptRequest, type ProposalDeclineRequest, type ProposeSpawnRequest, type Refusal, type SessionContext, type SpawnPlan,
} from './session-requests';
import { placedParentOf } from './team';

export type { SpawnProposal } from '../../pty-sidecar/proposals-core.cjs';

export const MAX_OPEN_PROPOSALS = 3;

/** The record a propose-spawn appends — every field the app knows, none the proposer claims: its
 *  role and name come from its session record, and `to` is where the TREE places it right now. */
export type ProposeEvent = Omit<SpawnProposal, 'state'> & { ev: 'propose' };

const short = (p: SpawnProposal): string => `${p.id} (${p.role} — "${p.task.length > 50 ? `${p.task.slice(0, 49)}…` : p.task}")`;

/** Decide a propose-spawn. `id` and `ts` are the caller's (it owns the clock and the randomness). */
export function evaluatePropose(
	req: ProposeSpawnRequest, ctx: SessionContext, proposals: readonly SpawnProposal[], minted: { id: string; ts: number },
): Refusal | { ok: true; event: ProposeEvent } {
	if (!ctx.enabled) return { ok: false, reason: MANAGERS_OFF_REASON };
	const me = requesterOf(ctx);
	if (!me) return { ok: false, reason: `no live session owns this request directory (${ctx.requesterId})` };
	const mine = proposals.filter((p) => p.from.sessionId === me.sessionId);
	const open = mine.filter((p) => p.state === 'open');
	if (open.length >= MAX_OPEN_PROPOSALS) {
		return { ok: false, reason: `${me.name} already has ${open.length} open proposals, the most a session may hold: ${open.map(short).join('; ')}. Wait for a decision before proposing more` };
	}
	const key = proposalKey(req.role, req.task);
	const declined = mine.find((p) => p.state === 'declined' && proposalKey(p.role, p.task) === key);
	if (declined) {
		return { ok: false, reason: `this was proposed and declined as ${declined.id}: "${declined.reason ?? '(no reason)'}" — a declined proposal is not re-proposed` };
	}
	const parent = placedParentOf(floorTree(ctx.sessions, ctx.lookup), me.sessionId);
	return {
		ok: true,
		event: {
			ev: 'propose', id: minted.id, ts: minted.ts,
			from: { sessionId: me.sessionId, role: me.role, name: me.name },
			to: parent?.sessionId ?? null,
			...(parent ? { toName: ctx.sessions.find((s) => s.sessionId === parent.sessionId)?.name ?? parent.sessionId } : {}),
			workstreamId: me.workstreamId ?? null,
			role: req.role, task: req.task, why: req.why,
		},
	};
}

/** The proposal a decision is about, if this requester may decide it at all. Addressed to the
 *  proposer's parent; one written while UNASSIGNED (to: null) may be taken by any manager. */
function decidable(id: string, ctx: SessionContext, proposals: readonly SpawnProposal[]): Refusal | { ok: true; p: SpawnProposal } {
	if (!ctx.enabled) return { ok: false, reason: MANAGERS_OFF_REASON };
	const me = requesterOf(ctx);
	if (!me) return { ok: false, reason: `no live session owns this request directory (${ctx.requesterId})` };
	const p = proposals.find((x) => x.id === id);
	if (!p) return { ok: false, reason: `no proposal "${id}"` };
	if (p.state !== 'open') return { ok: false, reason: `proposal ${id} is already ${p.state}${p.reason ? ` (${p.reason})` : ''}` };
	if (!ctx.sessions.some((s) => s.sessionId === p.from.sessionId)) return { ok: false, reason: `proposal ${id} is stale — ${p.from.name}, who proposed it, has ended` };
	const addressedToMe = p.to === me.sessionId || (p.to === null && isManager(ctx.lookup(me.role)));
	if (!addressedToMe) {
		const to = p.to === null ? 'any manager (it was written while unassigned)' : (ctx.sessions.find((s) => s.sessionId === p.to)?.name ?? p.to);
		return { ok: false, reason: `proposal ${id} is addressed to ${to}, not ${me.name}` };
	}
	return { ok: true, p };
}

/** Accept: re-run the spawn exactly as a direct one. The repo defaults to the proposer's own. */
export function evaluateAccept(req: ProposalAcceptRequest, ctx: SessionContext, proposals: readonly SpawnProposal[]): Refusal | (SpawnPlan & { proposal: SpawnProposal }) {
	const d = decidable(req.proposal, ctx, proposals);
	if (!d.ok) return d;
	const repo = req.repo ?? ctx.sessions.find((s) => s.sessionId === d.p.from.sessionId)?.repoName ?? null;
	if (!repo) return { ok: false, reason: `proposal ${d.p.id} names no repo and its proposer has none — accept it with --repo <repo>` };
	const plan = evaluateSessionRequest({
		v: req.v, id: req.id, sentMs: req.sentMs, kind: 'spawn',
		repo, base: req.base, task: d.p.task, model: null, effort: null, name: null,
		role: d.p.role, workstream: d.p.workstreamId, taskClass: null, writes: null, isolation: null,
	}, ctx);
	if (!plan.ok) return plan;
	if (plan.action !== 'spawn') return { ok: false, reason: 'internal: accept did not plan a spawn' };
	return { ...plan, proposal: d.p };
}

/** Decline: no rung needed — the addressee may always say no, with a reason the proposer reads. */
export function evaluateDecline(req: ProposalDeclineRequest, ctx: SessionContext, proposals: readonly SpawnProposal[]): Refusal | { ok: true; proposal: SpawnProposal } {
	const d = decidable(req.proposal, ctx, proposals);
	return d.ok ? { ok: true, proposal: d.p } : d;
}

/** Rule 3: the open proposals a session leaves behind when it ends. */
export function staleOnEnd(proposals: readonly SpawnProposal[], sessionId: string): SpawnProposal[] {
	return proposals.filter((p) => p.state === 'open' && p.from.sessionId === sessionId);
}

/** For display: a proposal still open whose proposer is not on the floor reads as stale even before
 *  its stale line is written (the app was not running when the session ended, say). */
export function effectiveState(p: SpawnProposal, liveSessionIds: ReadonlySet<string>): SpawnProposal['state'] {
	return p.state === 'open' && !liveSessionIds.has(p.from.sessionId) ? 'stale' : p.state;
}
