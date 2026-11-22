// Isolation modes: where a new session works, and what it may write (V2 ladder step 8, "isolation A").
// Pure: no fs, no window, no git. Same inputs, same answer. The grid gathers the inputs, calls
// decideIsolation, then executes the answer (gather → plan → execute, like planClose/planMove).
//
// What this step grants, and what it deliberately does not:
// - `shared-readonly` and `scratch` take no lock, so they add no collision risk. They are granted
//   under the `cheap-readonly` setting.
// - `shared-write` stays in the Mode union and is NEVER granted here. It needs the `_claims/`
//   write lease and the Edit/Write hook (step 9); without them it would be an unguarded write
//   into a shared checkout. An explicit request for it is refused, naming a holder and a path.
// - `worktree-always` (the default) answers `worktree` for every write-capable spawn — exactly
//   today's behaviour, so the step is inert until the setting is switched. It is also the rollback.
// - The rung ceiling applies under EVERY policy, before the policy is consulted: an observer or
//   proposer gets shared-readonly or scratch, never a worktree, and a repo write is refused.

import { lockStatus } from '../terminals/coordination';
// The write hook's own pure logic, imported rather than mirrored: the id a claim is keyed on and the
// escalation rule must be the SAME code in the app and in the hook, not two copies kept in step.
import * as claimsCore from '../../pty-sidecar/claims-core.cjs';

export type Mode = 'worktree' | 'shared-readonly' | 'shared-write' | 'scratch';
export type TaskClass = 'feature' | 'small-fix' | 'config' | 'investigate' | 'doc' | 'release';
export type Writes = 'none' | 'repo' | 'outside';
/** `cheapest-safe` (which can grant shared-write) is step 9 and is not accepted here. */
export type IsolationPolicy = 'worktree-always' | 'cheap-readonly';
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

/** A write lease on a checkout (design §2 "Claims"). The store that holds these is step 9; at
 *  this step the array is always empty, but the liveness rule is already the real one. */
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

/** Decide where a session works. See the module header for what each policy grants.
 *
 *  Properties the tests hold this to:
 *  1. It never refuses when a worktree would do — the only refusals are an explicit
 *     `requested: 'shared-write'` and a repo write by a read-only role.
 *  2. It never widens a role — under EVERY policy a read-only rung gets shared-readonly or
 *     scratch whatever the brief asks for, and a repo write is refused naming the role and path.
 *  3. A stale claim counts as free (claimIsLive). */
export function decideIsolation(i: IsolationIntent, c: IsolationContext): IsolationDecision {
	const where = i.checkout.path;

	// shared-write is not grantable at this step under ANY policy: there is no lease store and no
	// write hook yet. Name whoever holds the checkout if someone does; otherwise the holder is the
	// setting itself — that is what is withholding it, and what someone would change.
	if (i.requested === 'shared-write') {
		const live = liveClaimOn(i.checkout.id, c.claims, c.now);
		if (live) return { ok: false, reason: `shared-write refused — ${live.path} is held by ${live.holder}`, holder: live.holder, path: live.path };
		return {
			ok: false,
			reason: 'shared-write is not available yet — it needs the write lease and write hook (V2 step 9); spawn without --isolation shared-write to get a worktree',
			holder: `isolation setting "${c.policy}"`,
			path: where,
		};
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

	// cheap-readonly, a write-capable rung. A repo write always gets a worktree at this step.
	if (i.writes === 'repo') {
		const note = i.requested === 'shared-readonly' || i.requested === 'scratch' ? ` (requested ${i.requested}, but the task declares repo writes)` : '';
		return granted('worktree', `repo writes get their own worktree${note}`);
	}
	if (i.requested === 'worktree') return granted('worktree', 'worktree requested explicitly');
	if (i.writes === 'outside') return granted('scratch', 'writes nothing in the repo — scratch, outside any registered target');
	return granted('shared-readonly', 'writes nothing — reads the existing checkout, no worktree');
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

/** Only the exact value `cheap-readonly` switches the step on. Anything else — missing, junk, or
 *  `cheapest-safe` (step 9, not built) — reads as the default, today's behaviour. */
export function parseIsolationPolicy(v: unknown): IsolationPolicy {
	return typeof v === 'string' && v.trim().toLowerCase() === 'cheap-readonly' ? 'cheap-readonly' : DEFAULT_POLICY;
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
	if (mode === 'scratch') {
		return 'scratch — this working directory is a scratch folder outside every registered repository. '
			+ 'Write here, or to a vault path your brief names. Do not write inside any repository — the write hook denies file-tool writes '
			+ 'inside the one this session came from. ' + SHELL_WRITES + ' '
			+ 'If the task needs a repository change, stop and say so — it must be respawned with its own worktree.';
	}
	return undefined;
}
