// Isolation modes: where a new session works, and what it may write (V2 ladder steps 8 and 9,
// "isolation A" and "B"). Pure: no fs, no window, no git. Same inputs, same answer. The grid
// gathers the inputs (the claims among them), calls decideIsolation, then executes the answer
// (gather → plan → execute, like planClose/planMove).
//
// What each setting grants:
// - `worktree-always` (the default) answers `worktree` for every write-capable spawn — exactly
//   the behaviour before step 8. It is also the rollback.
// - `cheap-readonly` (step 8) adds `shared-readonly` and `scratch`. They take no lock, so they add
//   no collision risk; since step 9 the write hook enforces them.
// - `cheapest-safe` (step 9) adds `shared-write`: a small fix, a config edit, a release — and an
//   investigation or doc that turns out to write the repo — may write an existing checkout while
//   holding its exclusive write lease (`write:<checkout id>` in `_claims/`). A held checkout makes
//   it a worktree instead (FR-12); only `release` and an explicit request can be refused, and a
//   refusal names the holder and the path (FR-17). Feature work always gets a worktree.
//   Rolling back to `cheap-readonly` needs no cleanup: leases expire on their own within the TTL.
// - The rung ceiling applies under EVERY policy, before the policy is consulted: an observer or
//   proposer gets shared-readonly or scratch, never a worktree or a lease, and a repo write is refused.
//
// Q9 is decided, leniently: a worktree session's claim is on its own path, so it does not block
// shared-write in the primary. Only a claim on THIS checkout's id counts (liveClaimOn).

import { lockStatus } from '../terminals/coordination';
// The write hook's own pure logic, imported rather than mirrored: the id a claim is keyed on and the
// escalation rule must be the SAME code in the app and in the hook, not two copies kept in step.
import * as claimsCore from '../../pty-sidecar/claims-core.cjs';

export type Mode = 'worktree' | 'shared-readonly' | 'shared-write' | 'scratch';
export type TaskClass = 'feature' | 'small-fix' | 'config' | 'investigate' | 'doc' | 'release';
export type Writes = 'none' | 'repo' | 'outside';
/** config.json `isolation`. Only `cheapest-safe` can grant shared-write. */
export type IsolationPolicy = 'worktree-always' | 'cheap-readonly' | 'cheapest-safe';
export type RungCeiling = 'readonly' | 'write';

export const MODES: readonly Mode[] = ['worktree', 'shared-readonly', 'shared-write', 'scratch'];
export const TASK_CLASSES: readonly TaskClass[] = ['feature', 'small-fix', 'config', 'investigate', 'doc', 'release'];
export const WRITES: readonly Writes[] = ['none', 'repo', 'outside'];
export const DEFAULT_POLICY: IsolationPolicy = 'worktree-always';

export interface IsolationIntent {
	taskClass: TaskClass;
	/** Declared by the brief, or implied by the class / the role's rung ceiling (resolveIntent). */
	writes: Writes;
	/** id = git common dir + worktree path; `primary` = the repo's own checkout, not a worktree. */
	checkout: { id: string; path: string; primary: boolean };
	/** An explicit override from the CLI (`spawn --isolation`) or, later, the sheet. */
	requested?: Mode;
}

/** A write lease on a checkout (design §2 "Claims"), as read from `_claims/` (claims-store.cjs). */
export interface Claim { resource: string; sessionId: string; holder: string; path: string; ts: number; ttlMs: number }

export interface IsolationContext {
	now: number;
	claims: Claim[];
	policy: IsolationPolicy;
	rungCeiling: RungCeiling;
	/** The role slug, so a ceiling refusal can name it. Defaults to "this role". */
	role?: string;
}

export type IsolationDecision =
	| { ok: true; mode: Mode; acquire: string[]; reason: string }
	// Both always present: a refusal that cannot say who holds the thing is a dead end (FR-17).
	| { ok: false; reason: string; holder: string; path: string };

/** The lease resource for a checkout. */
export function writeResource(checkoutId: string): string { return `write:${checkoutId}`; }

/** Is a claim live? The SAME rule `lockStatus` applies to every coordination lock
 *  (coord-core.cjs lockStatus, mirrored in coordination.ts): past its TTL it is stale, and a
 *  stale claim counts as free — a dead holder must not block anyone. */
export function claimIsLive(claim: Claim, now: number): boolean {
	return lockStatus(claim, now) === 'held';
}

/** The live write claim on this checkout, if any. */
export function liveClaimOn(checkoutId: string, claims: readonly Claim[], now: number): Claim | null {
	const res = writeResource(checkoutId);
	return claims.find((c) => c.resource === res && claimIsLive(c, now)) ?? null;
}

const granted = (mode: Mode, reason: string): IsolationDecision => ({ ok: true, mode, acquire: [], reason });
const sharedWrite = (i: IsolationIntent, reason: string): IsolationDecision => ({ ok: true, mode: 'shared-write', acquire: [writeResource(i.checkout.id)], reason });

/** Task classes that may write an existing checkout under a lease (cheapest-safe). `feature` never
 *  does: it needs its own branch and a reviewable diff. The write hook's escalation rule
 *  (claims-core canEscalate) is held to the same answer by a test. */
const LEASE_CLASSES: readonly TaskClass[] = ['small-fix', 'config', 'investigate', 'doc', 'release'];

/** Decide where a session works. See the module header for what each policy grants.
 *
 *  Properties the tests hold this to:
 *  1. It never refuses when a worktree would do — the only refusals are an explicit
 *     `requested: 'shared-write'`, a `release` on a held checkout, and a repo write by a
 *     read-only role. Every refusal names a holder and a path (FR-17).
 *  2. It never widens a role — under EVERY policy a read-only rung gets shared-readonly or
 *     scratch whatever the brief asks for, and a repo write is refused naming the role and path.
 *  3. A stale claim counts as free (claimIsLive).
 *  4. shared-write is granted only under `cheapest-safe`, only on a checkout no live claim holds
 *     (FR-18), and always with `acquire: [write:<id>]` — the spawn path takes that lease before
 *     the session exists, and falls back to this function's answer again if it loses the race. */
export function decideIsolation(i: IsolationIntent, c: IsolationContext): IsolationDecision {
	const where = i.checkout.path;

	const live = liveClaimOn(i.checkout.id, c.claims, c.now);

	// An explicit shared-write request: granted only where it is safe, refused otherwise — an
	// explicit request is not quietly turned into something else. The holder named is whatever is
	// withholding it: a role, the setting, or the session that has the lease.
	if (i.requested === 'shared-write') {
		if (c.rungCeiling === 'readonly') {
			const role = c.role || 'this role';
			return { ok: false, reason: `shared-write refused — ${role} is a read-only rung and cannot write a repository`, holder: role, path: where };
		}
		// A live holder is named before the setting: "someone has it" is the more useful answer.
		if (live) return { ok: false, reason: `shared-write refused — ${live.path} is held by ${live.holder}`, holder: live.holder, path: live.path };
		if (c.policy !== 'cheapest-safe') {
			return {
				ok: false,
				reason: `shared-write refused — the isolation setting is "${c.policy}", and only "cheapest-safe" grants it; spawn without --isolation shared-write to get a worktree`,
				holder: `isolation setting "${c.policy}"`,
				path: where,
			};
		}
		return sharedWrite(i, 'shared-write requested explicitly — takes the write lease on this checkout');
	}

	// The rung ceiling comes BEFORE the policy: it can only narrow, and it narrows under every
	// policy. A worktree is a place to write the repo, so handing one to a read-only rung — even
	// under worktree-always — would widen the role (design §2: "It never widens a role").
	if (c.rungCeiling === 'readonly') {
		const role = c.role || 'this role';
		if (i.writes === 'repo') {
			return { ok: false, reason: `${role} is a read-only rung and cannot write a repository — ${where} would be written`, holder: role, path: where };
		}
		if (i.writes === 'outside') return granted('scratch', `${role} is read-only: writes go to scratch, never into a registered target`);
		return granted('shared-readonly', `${role} is read-only: reads the existing checkout, no worktree`);
	}

	// The default and the rollback for write-capable rungs: every spawn gets its own worktree, as
	// before this step.
	if (c.policy === 'worktree-always') return granted('worktree', 'isolation: worktree-always — every session gets its own worktree');

	// cheapest-safe, a write-capable rung, a repo write: a lease where it is safe and cheap.
	if (c.policy === 'cheapest-safe' && i.writes === 'repo' && i.requested !== 'worktree') {
		if (!LEASE_CLASSES.includes(i.taskClass)) return granted('worktree', `${i.taskClass} work gets its own branch and worktree`);
		if (live) {
			// A release must see the real checkout and its tags; a worktree of it cannot stand in.
			if (i.taskClass === 'release') return { ok: false, reason: `release refused — ${live.path} is held by ${live.holder}; a release must run in the real checkout`, holder: live.holder, path: live.path };
			return granted('worktree', `${live.path} is held by ${live.holder} — a worktree instead (FR-12)`);
		}
		return sharedWrite(i, `${i.taskClass}: writes this checkout under its exclusive write lease`);
	}

	// cheap-readonly (or cheapest-safe asked for a worktree), a write-capable rung: a repo write gets a worktree.
	if (i.writes === 'repo') {
		const note = i.requested === 'shared-readonly' || i.requested === 'scratch' ? ` (requested ${i.requested}, but the task declares repo writes)` : '';
		return granted('worktree', `repo writes get their own worktree${note}`);
	}
	if (i.requested === 'worktree') return granted('worktree', 'worktree requested explicitly');
	if (i.writes === 'outside') return granted('scratch', 'writes nothing in the repo — scratch, outside any registered target');
	return granted('shared-readonly', 'writes nothing — reads the existing checkout, no worktree');
}

/** One spawn's isolation inputs and the decision made from them (the grid's planIsolation). */
export interface IsolationPlan { intent: IsolationIntent; ctx: IsolationContext; decision: IsolationDecision }

/** A stored claim (claims-store.cjs) as decideIsolation reads it. */
export function claimOf(c: { resource: string; sessionId: string; holder: string; path: string; ts: number; ttlMs: number }): Claim {
	return { resource: c.resource, sessionId: c.sessionId, holder: c.holder, path: c.path, ts: c.ts, ttlMs: c.ttlMs };
}

/** A shared-write grant whose lease was taken by someone else between planning and the take:
 *  decide again with the winner's claim. That is a worktree (FR-12) or, for a release or an
 *  explicit request, a refusal naming the winner. Never shared-write again — the take already
 *  failed, and an answer that would retry it could loop. `winner` null (its file could not be
 *  read): refuse, naming the path, since nobody can be named. */
export function redecideAfterLostRace(plan: IsolationPlan, winner: Claim | null, path: string): IsolationDecision {
	if (!winner) return { ok: false, reason: `the write lease on ${path} could not be taken, and its holder could not be read`, holder: 'unknown holder', path };
	const d = decideIsolation(plan.intent, { ...plan.ctx, claims: [...plan.ctx.claims, claimOf(winner)] });
	if (d.ok && d.mode === 'shared-write') return { ok: true, mode: 'worktree', acquire: [], reason: `${path} was taken while this spawn was planned — a worktree instead (FR-12)` };
	return d;
}

// ---- Intent: filling in what the brief did not declare.

/** What a class writes when the brief does not say (design §8 table). */
export function defaultWritesFor(taskClass: TaskClass): Writes {
	if (taskClass === 'investigate') return 'none';
	if (taskClass === 'doc') return 'outside';
	return 'repo';
}

/** Raw spawn fields (CLI strings) → a typed intent. Junk reads as absent. An undeclared `writes`
 *  comes from the class; under a read-only ceiling an undeclared repo write becomes 'none' —
 *  the rung declares it (design: "declared by the brief, or by the role's rung ceiling"). An
 *  EXPLICIT `--writes repo` is kept, so a read-only role asking for it is refused, not quietly
 *  narrowed. Absent class reads as 'feature', the conservative one. */
export function resolveIntent(
	raw: { taskClass?: unknown; writes?: unknown; requested?: unknown },
	checkout: IsolationIntent['checkout'],
	rungCeiling: RungCeiling,
): IsolationIntent {
	const taskClass = pick(raw.taskClass, TASK_CLASSES) ?? 'feature';
	const declared = pick(raw.writes, WRITES);
	let writes = declared ?? defaultWritesFor(taskClass);
	if (!declared && rungCeiling === 'readonly' && writes === 'repo') writes = 'none';
	const requested = pick(raw.requested, MODES);
	return { taskClass, writes, checkout, ...(requested ? { requested } : {}) };
}

function pick<T extends string>(v: unknown, set: readonly T[]): T | undefined {
	if (typeof v !== 'string') return undefined;
	const s = v.trim().toLowerCase();
	return (set as readonly string[]).includes(s) ? (s as T) : undefined;
}

// ---- The rung ceiling, from the role file's `authority:` (D16: no `isolation:` key on roles).

/** observer and proposer cannot land code, so they cannot need write isolation. Every other rung
 *  — operator, autonomous, an absent or unknown value (the compiled worker default is an
 *  operator) — is write-capable. Only an explicit low rung narrows. */
export function rungCeilingOf(authority: string | undefined): RungCeiling {
	const a = (authority ?? '').trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, '');
	return a === 'observer' || a === 'proposer' ? 'readonly' : 'write';
}

// ---- The setting: config.json `isolation`, default `worktree-always`.

/** Only an exact `cheap-readonly` or `cheapest-safe` changes anything. Anything else — missing or
 *  junk — reads as the default, `worktree-always`: an unreadable setting never widens. */
export function parseIsolationPolicy(v: unknown): IsolationPolicy {
	if (typeof v !== 'string') return DEFAULT_POLICY;
	const s = v.trim().toLowerCase();
	return s === 'cheap-readonly' || s === 'cheapest-safe' ? s : DEFAULT_POLICY;
}

// ---- The mode chip (design system: components/ModeChip).

export type ChipVariant = 'default' | 'worktree' | 'lease';
export interface ModeChip { text: string; variant: ChipVariant; title: string }

/** The chip for a mode. The variant is decided HERE, from the mode, never re-derived from the
 *  text by the component. Only the lease chip carries weight: it is the one mode with a
 *  consequence for somebody else. */
export function modeChip(mode: Mode): ModeChip {
	switch (mode) {
		case 'worktree': return { text: 'wt', variant: 'worktree', title: 'worktree — its own branch and checkout' };
		case 'shared-readonly': return { text: 'ro', variant: 'default', title: 'shared-readonly — reads an existing checkout, writes nothing' };
		case 'shared-write': return { text: 'rw🔒', variant: 'lease', title: 'shared-write — holds the exclusive write lease on this checkout' };
		case 'scratch': return { text: 'scr', variant: 'default', title: 'scratch — writes only outside any registered target' };
	}
}

/** The mode a session row shows. A recorded mode wins. With none (a record from before this step)
 *  a worktree tile is a worktree — that is a fact about the tile, not a re-derivation — and a
 *  plain folder target has no mode at all. */
export function sessionMode(recorded: Mode | undefined, folder: boolean | undefined): Mode | undefined {
	return recorded ?? (folder ? undefined : 'worktree');
}

/** A persisted mode string → a Mode, or undefined (an older record, or junk). */
export function parseMode(v: unknown): Mode | undefined { return pick(v, MODES); }

/** A persisted task class / rung ceiling → the value, or undefined (an older record, or junk —
 *  which the write hook reads as "never escalate"). */
export function parseTaskClass(v: unknown): TaskClass | undefined { return pick(v, TASK_CLASSES); }
export function parseRungCeiling(v: unknown): RungCeiling | undefined { return pick(v, ['readonly', 'write'] as const); }

// ---- isolation.jsonl: one append-only decision record per spawn.
//
// Needed rather than derived: the app's own `git worktree add` does not pass through the
// coordination hook, so board.md undercounts worktree creation, and the isolation-cost metric
// (step 11) has nothing else to count from.

export interface IsolationRecord {
	v: 1;
	ts: number;
	repo: string;
	checkout: string;
	primary: boolean;
	taskClass: TaskClass;
	writes: Writes;
	requested?: Mode;
	policy: IsolationPolicy;
	rungCeiling: RungCeiling;
	role?: string;
	ok: boolean;
	mode?: Mode;
	reason: string;
	holder?: string;
	path?: string;
	/** The session that was created, once known. Absent on a refusal or a failed spawn. */
	sessionId?: string;
	/** The worktree / working directory the session actually got, once known. */
	cwd?: string;
	/** Set when the decision was granted but executing it failed (e.g. `git worktree add`). */
	failed?: string;
}

export function isolationRecord(
	repo: string, i: IsolationIntent, c: IsolationContext, d: IsolationDecision,
	outcome: { sessionId?: string; cwd?: string; failed?: string } = {},
): IsolationRecord {
	return {
		v: 1, ts: c.now, repo,
		checkout: i.checkout.path, primary: i.checkout.primary,
		taskClass: i.taskClass, writes: i.writes,
		...(i.requested ? { requested: i.requested } : {}),
		policy: c.policy, rungCeiling: c.rungCeiling,
		...(c.role ? { role: c.role } : {}),
		ok: d.ok,
		...(d.ok ? { mode: d.mode } : { holder: d.holder, path: d.path }),
		reason: d.reason,
		...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
		...(outcome.cwd ? { cwd: outcome.cwd } : {}),
		...(outcome.failed ? { failed: outcome.failed } : {}),
	};
}

/** One JSONL line, newline-terminated, safe to append. */
export function formatIsolationLine(r: IsolationRecord): string { return JSON.stringify(r) + '\n'; }

// ---- The write gate (V2 step 9): what a session's hook is told, through its environment.

/** A checkout's claim id — the hook's own function (claims-core checkoutId), so a claim the app
 *  takes and a write the hook tests can never disagree on which checkout is meant. */
export function checkoutIdOf(p: string): string { return claimsCore.checkoutId(p); }

export interface WriteGateFacts {
	/** The checkout the session's gate (and any lease) is about: its own worktree, or the shared
	 *  checkout it reads / writes / came from (scratch). */
	checkout: string;
	/** The machine-wide claim store (claims-store claimsDirOf). */
	claimsDir: string;
	policy: IsolationPolicy;
	/** Recorded at spawn, for a shared-readonly session's escalation. Absent = no escalation. */
	rungCeiling?: RungCeiling;
	taskClass?: TaskClass;
}

/** The COS_* variables `coord-hook.cjs --write` reads. Empty for a session with no mode (a plain
 *  folder target, a record from before step 8): its hook then runs under the OPEN failure policy
 *  and checks only for someone else's lease. The mode is what selects the policy
 *  (coord-hook.cjs failurePolicyFor), so it is set exactly when the session has one. */
export function writeGateEnv(mode: Mode | undefined, f: WriteGateFacts): Record<string, string> {
	if (!mode) return {};
	return {
		COS_ISOLATION: mode,
		COS_CHECKOUT: f.checkout,
		COS_CLAIMS_DIR: f.claimsDir,
		COS_ISOLATION_POLICY: f.policy,
		...(f.rungCeiling ? { COS_RUNG: f.rungCeiling } : {}),
		...(f.taskClass ? { COS_TASK_CLASS: f.taskClass } : {}),
	};
}

/** Would this shared-readonly session's first write be granted the lease (when the checkout is
 *  free)? The hook's own rule (claims-core canEscalate), so the prompt and the gate agree. */
export function canEscalate(policy: IsolationPolicy, rungCeiling: RungCeiling | undefined, taskClass: TaskClass | undefined): boolean {
	return claimsCore.canEscalate(policy, rungCeiling, taskClass);
}

// ---- What a non-worktree session is told about its mode.

/** Said to every shared or scratch session: the one hole in the write gate, named. */
const SHELL_WRITES = 'The write hook sees only the file tools (Edit, Write, NotebookEdit). A shell command that writes — '
	+ 'a redirect, a formatter, an install, a build that emits output, git commit / checkout / stash / reset — '
	+ 'is not caught by it, and is forbidden here all the same.';

/** The instruction a shared or scratch session carries in its prompt. Undefined for a worktree,
 *  whose role text (Worker Terminal) already says where to write. Since step 9 the write hook
 *  ENFORCES the file-tool half of this; the shell half is still only this text, and the text says
 *  so rather than implying a sandbox. */
export function isolationInstruction(mode: Mode | undefined, opts: { escalates?: boolean } = {}): string | undefined {
	if (mode === 'shared-readonly') {
		const head = 'shared-readonly — this working directory is a SHARED checkout that other sessions use, not a worktree of your own. ';
		if (opts.escalates) {
			return head
				+ 'You start read-only. Your first file-tool write asks for this checkout\'s exclusive write lease: if no other session holds it, '
				+ 'you get it and keep it while you keep writing, and nobody else can write here meanwhile. Commit your change before you finish — '
				+ 'a lease is released only from a clean checkout. If a write is denied, stop and say so; do not retry it another way. '
				+ SHELL_WRITES;
		}
		return head
			+ 'Read only: do not create, edit or delete any file in it — the write hook denies file-tool writes here. '
			+ SHELL_WRITES + ' '
			+ 'If the task turns out to need a write, stop and say so — it must be respawned with its own worktree.';
	}
	if (mode === 'shared-write') {
		return 'shared-write — this working directory is a SHARED checkout (the repository\'s own, not a worktree of yours), and this session '
			+ 'holds its exclusive write lease: no other session can write here while you hold it. Other sessions may be reading it, so '
			+ 'never git checkout / switch / stash / reset / rebase here. The lease lives while you keep writing — after 10 minutes without a '
			+ 'file-tool write it lapses, and if a write is then denied, another session has it: stop and say so. Make the change, commit it '
			+ '(that commit is the one shell write you are here to make), and finish. The lease is released when the session ends, and only '
			+ 'from a clean checkout; `cos-coord lease release` gives it up early. '
			+ 'The write hook sees only the file tools (Edit, Write, NotebookEdit): any other shell command that writes — a redirect, a formatter, '
			+ 'an install, a build that emits output — is not caught by it, and is forbidden here all the same.';
	}
	if (mode === 'scratch') {
		return 'scratch — this working directory is a scratch folder outside every registered repository. '
			+ 'Write here, or to a vault path your brief names. Do not write inside any repository — the write hook denies file-tool writes '
			+ 'inside the one this session came from. ' + SHELL_WRITES + ' '
			+ 'If the task needs a repository change, stop and say so — it must be respawned with its own worktree.';
	}
	return undefined;
}
