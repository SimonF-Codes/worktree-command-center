// decideIsolation under `cheapest-safe` (V2 step 9): shared-write, granted only where it is safe.
// Pure, so every case is data. The contention itself — two sessions racing for one checkout's
// lease — is the collision suite (claims-collision.test.ts).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
	decideIsolation, redecideAfterLostRace, writeResource, canEscalate,
	TASK_CLASSES, WRITES, MODES,
	type IsolationIntent, type IsolationContext, type Claim, type IsolationPolicy, type RungCeiling,
} from '../src/core/isolation';
const require = createRequire(import.meta.url);
const cc = require('../pty-sidecar/claims-core.cjs');

const checkout = { id: 'c:/dev/app', path: 'C:/dev/app', primary: true };
const NOW = 1_000_000_000;
const intent = (o: Partial<IsolationIntent> = {}): IsolationIntent => ({ taskClass: 'small-fix', writes: 'repo', checkout, ...o });
const ctx = (o: Partial<IsolationContext> = {}): IsolationContext => ({ now: NOW, claims: [], policy: 'cheapest-safe', rungCeiling: 'write', ...o });
const claim = (o: Partial<Claim> = {}): Claim => ({ resource: writeResource(checkout.id), sessionId: 's-1', holder: 'fix-auth', path: checkout.path, ts: NOW - 60_000, ttlMs: 600_000, ...o });

const POLICIES: IsolationPolicy[] = ['worktree-always', 'cheap-readonly', 'cheapest-safe'];
const CEILINGS: RungCeiling[] = ['write', 'readonly'];
function* everyCase(): Generator<[IsolationIntent, IsolationContext]> {
	for (const taskClass of TASK_CLASSES) for (const writes of WRITES) for (const requested of [undefined, ...MODES])
		for (const policy of POLICIES) for (const rungCeiling of CEILINGS)
			for (const claims of [[], [claim()], [claim({ ts: NOW - 600_001 })], [claim({ resource: writeResource('c:/dev/app/.claude-worktrees/wt-1'), path: 'C:/dev/app/.claude-worktrees/wt-1' })]])
				yield [intent({ taskClass, writes, ...(requested ? { requested } : {}) }), ctx({ policy, rungCeiling, claims })];
}

describe('cheapest-safe: which task gets a lease', () => {
	it('small-fix / config / investigate / doc / release that write the repo → shared-write, acquiring write:<id>', () => {
		for (const taskClass of ['small-fix', 'config', 'investigate', 'doc', 'release'] as const) {
			expect(decideIsolation(intent({ taskClass }), ctx())).toEqual({ ok: true, mode: 'shared-write', acquire: ['write:c:/dev/app'], reason: expect.any(String) });
		}
	});
	it('feature → worktree, always: it needs its own branch', () => {
		expect(decideIsolation(intent({ taskClass: 'feature' }), ctx())).toMatchObject({ ok: true, mode: 'worktree', acquire: [] });
	});
	it('writes none / outside are exactly as under cheap-readonly', () => {
		expect(decideIsolation(intent({ writes: 'none' }), ctx())).toMatchObject({ ok: true, mode: 'shared-readonly' });
		expect(decideIsolation(intent({ writes: 'outside' }), ctx())).toMatchObject({ ok: true, mode: 'scratch' });
	});
	it('an explicit worktree request is honoured', () => {
		expect(decideIsolation(intent({ requested: 'worktree' }), ctx())).toMatchObject({ ok: true, mode: 'worktree' });
	});
});

describe('cheapest-safe: a held checkout (FR-12, FR-17, FR-18)', () => {
	it('small-fix on a held checkout falls back to a worktree — never a refusal', () => {
		for (const taskClass of ['small-fix', 'config', 'investigate', 'doc'] as const) {
			const d = decideIsolation(intent({ taskClass }), ctx({ claims: [claim()] }));
			expect(d).toMatchObject({ ok: true, mode: 'worktree' });
			if (d.ok) expect(d.reason).toContain('fix-auth');
		}
	});
	it('a release on a held checkout is refused, naming the holder and the path', () => {
		expect(decideIsolation(intent({ taskClass: 'release' }), ctx({ claims: [claim()] }))).toEqual({ ok: false, reason: expect.stringContaining('fix-auth'), holder: 'fix-auth', path: 'C:/dev/app' });
	});
	it('a stale claim is free', () => {
		expect(decideIsolation(intent(), ctx({ claims: [claim({ ts: NOW - 600_001 })] }))).toMatchObject({ ok: true, mode: 'shared-write' });
	});
	it('Q9, lenient: a worktree session\'s claim on its own path does not block the primary', () => {
		const wtClaim = claim({ resource: writeResource('c:/dev/app/.claude-worktrees/wt-1'), path: 'C:/dev/app/.claude-worktrees/wt-1' });
		expect(decideIsolation(intent(), ctx({ claims: [wtClaim] }))).toMatchObject({ ok: true, mode: 'shared-write' });
	});
});

describe('an explicit shared-write request', () => {
	it('free → granted under cheapest-safe', () => {
		expect(decideIsolation(intent({ taskClass: 'feature', requested: 'shared-write' }), ctx())).toMatchObject({ ok: true, mode: 'shared-write', acquire: ['write:c:/dev/app'] });
	});
	it('held → refused, naming the holder and the path', () => {
		expect(decideIsolation(intent({ requested: 'shared-write' }), ctx({ claims: [claim()] }))).toMatchObject({ ok: false, holder: 'fix-auth', path: 'C:/dev/app' });
	});
	it('a read-only rung → refused, naming the role', () => {
		expect(decideIsolation(intent({ requested: 'shared-write' }), ctx({ rungCeiling: 'readonly', role: 'researcher' }))).toMatchObject({ ok: false, holder: 'researcher', path: 'C:/dev/app' });
	});
	it('any other policy → refused, naming the setting', () => {
		for (const policy of ['worktree-always', 'cheap-readonly'] as const) {
			const d = decideIsolation(intent({ requested: 'shared-write' }), ctx({ policy }));
			expect(d).toMatchObject({ ok: false, path: 'C:/dev/app' });
			if (!d.ok) expect(d.holder).toContain(policy);
		}
	});
});

describe('properties over every case, all three policies', () => {
	it('shared-write is granted only under cheapest-safe, to a write rung, on a checkout no live claim holds, with its lease in acquire', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (!(d.ok && d.mode === 'shared-write')) continue;
			expect(c.policy).toBe('cheapest-safe');
			expect(c.rungCeiling).toBe('write');
			expect(c.claims.some((x) => x.resource === writeResource(checkout.id) && NOW <= x.ts + x.ttlMs)).toBe(false);
			expect(d.acquire).toEqual([writeResource(checkout.id)]);
		}
	});
	it('never widens a role: a read-only rung never gets a worktree or a lease', () => {
		for (const [i, c] of everyCase()) {
			if (c.rungCeiling !== 'readonly') continue;
			const d = decideIsolation(i, c);
			if (d.ok) expect(['shared-readonly', 'scratch']).toContain(d.mode);
		}
	});
	it('every refusal names a non-empty holder and path (FR-17)', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (!d.ok) { expect(d.holder.length).toBeGreaterThan(0); expect(d.path.length).toBeGreaterThan(0); }
		}
	});
	it('the only refusals: an explicit shared-write, a release on a held checkout, a read-only role writing the repo', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (d.ok) continue;
			const explicit = i.requested === 'shared-write';
			const release = c.policy === 'cheapest-safe' && i.taskClass === 'release' && i.writes === 'repo';
			const ceiling = c.rungCeiling === 'readonly' && i.writes === 'repo';
			expect(explicit || release || ceiling).toBe(true);
		}
	});
	it('worktree-always and cheap-readonly never grant shared-write — the rollback really rolls back', () => {
		for (const [i, c] of everyCase()) {
			if (c.policy === 'cheapest-safe') continue;
			const d = decideIsolation(i, c);
			if (d.ok) expect(d.mode).not.toBe('shared-write');
		}
	});
});

describe('the hook escalates by the same rule (drift)', () => {
	it('canEscalate ⇔ decideIsolation would grant shared-write for a repo write, for every policy, rung and class', () => {
		for (const policy of POLICIES) for (const rungCeiling of CEILINGS) for (const taskClass of TASK_CLASSES) {
			const d = decideIsolation(intent({ taskClass }), ctx({ policy, rungCeiling }));
			const grants = d.ok && d.mode === 'shared-write';
			expect(cc.canEscalate(policy, rungCeiling, taskClass)).toBe(grants);
			expect(canEscalate(policy, rungCeiling, taskClass)).toBe(grants);
		}
	});
	it('an absent rung or class never escalates', () => {
		expect(cc.canEscalate('cheapest-safe', undefined, 'small-fix')).toBe(false);
		expect(cc.canEscalate('cheapest-safe', 'write', undefined)).toBe(false);
	});
});

describe('redecideAfterLostRace: the spawn path lost the lease between plan and take', () => {
	const plan = (o: Partial<IsolationIntent> = {}) => { const i = intent(o); const c = ctx(); return { intent: i, ctx: c, decision: decideIsolation(i, c) }; };
	it('a small-fix becomes a worktree, naming the winner', () => {
		const d = redecideAfterLostRace(plan(), claim({ holder: 'quick-fix' }), 'C:/dev/app');
		expect(d).toMatchObject({ ok: true, mode: 'worktree' });
		if (d.ok) expect(d.reason).toContain('quick-fix');
	});
	it('a release is refused, naming the winner and the path', () => {
		expect(redecideAfterLostRace(plan({ taskClass: 'release' }), claim({ holder: 'quick-fix' }), 'C:/dev/app')).toMatchObject({ ok: false, holder: 'quick-fix', path: 'C:/dev/app' });
	});
	it('never answers shared-write again, even when the winner\'s claim reads as stale', () => {
		const d = redecideAfterLostRace(plan(), claim({ ts: 0 }), 'C:/dev/app');
		expect(d.ok && d.mode).toBe('worktree');
	});
	it('an unreadable winner is a refusal naming the path', () => {
		expect(redecideAfterLostRace(plan(), null, 'C:/dev/app')).toMatchObject({ ok: false, path: 'C:/dev/app' });
	});
});
