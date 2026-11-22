import { describe, it, expect } from 'vitest';
import {
	decideIsolation, resolveIntent, rungCeilingOf, parseIsolationPolicy, claimIsLive, liveClaimOn, writeResource,
	modeChip, parseMode, isolationRecord, formatIsolationLine, defaultWritesFor,
	TASK_CLASSES, WRITES, MODES,
	type IsolationIntent, type IsolationContext, type Claim, type IsolationPolicy, type RungCeiling,
} from '../src/core/isolation';

// No repo, no window: the decision is a pure function, so every case is just data.
const checkout = { id: 'C:/dev/app/.git|C:/dev/app', path: 'C:/dev/app', primary: true };
const NOW = 1_000_000_000;
const intent = (o: Partial<IsolationIntent> = {}): IsolationIntent => ({ taskClass: 'feature', writes: 'repo', checkout, ...o });
const ctx = (o: Partial<IsolationContext> = {}): IsolationContext => ({ now: NOW, claims: [], policy: 'cheap-readonly', rungCeiling: 'write', ...o });
const claim = (o: Partial<Claim> = {}): Claim => ({ resource: writeResource(checkout.id), sessionId: 's-1', holder: 'fix-auth', path: checkout.path, ts: NOW - 60_000, ttlMs: 600_000, ...o });

const POLICIES: IsolationPolicy[] = ['worktree-always', 'cheap-readonly'];
const CEILINGS: RungCeiling[] = ['write', 'readonly'];
const REQUESTS = [undefined, ...MODES];

/** Every intent × context this step can be handed. */
function* everyCase(): Generator<[IsolationIntent, IsolationContext]> {
	for (const taskClass of TASK_CLASSES) for (const writes of WRITES) for (const requested of REQUESTS)
		for (const policy of POLICIES) for (const rungCeiling of CEILINGS) for (const claims of [[], [claim()]])
			yield [intent({ taskClass, writes, ...(requested ? { requested } : {}) }), ctx({ policy, rungCeiling, claims })];
}

describe('decideIsolation — worktree-always (the default and the rollback)', () => {
	it('answers worktree for any repo write, as today', () => {
		for (const taskClass of TASK_CLASSES) {
			const d = decideIsolation(intent({ taskClass }), ctx({ policy: 'worktree-always' }));
			expect(d).toEqual({ ok: true, mode: 'worktree', acquire: [], reason: expect.any(String) });
		}
	});
	it('is inert for write-capable rungs: every spawn gets a worktree, whatever it writes', () => {
		for (const [i, c] of everyCase()) {
			if (c.policy !== 'worktree-always' || c.rungCeiling !== 'write' || i.requested === 'shared-write') continue;
			const d = decideIsolation(i, c);
			expect(d.ok && d.mode).toBe('worktree');
		}
	});
});

describe('decideIsolation — cheap-readonly grants only the lock-free modes', () => {
	it('writes none → shared-readonly, writes outside → scratch, repo → worktree', () => {
		expect(decideIsolation(intent({ writes: 'none' }), ctx())).toMatchObject({ ok: true, mode: 'shared-readonly', acquire: [] });
		expect(decideIsolation(intent({ writes: 'outside' }), ctx())).toMatchObject({ ok: true, mode: 'scratch', acquire: [] });
		expect(decideIsolation(intent({ writes: 'repo' }), ctx())).toMatchObject({ ok: true, mode: 'worktree', acquire: [] });
	});
	it('an explicit worktree request is honoured for a write-capable rung', () => {
		expect(decideIsolation(intent({ writes: 'none', requested: 'worktree' }), ctx())).toMatchObject({ ok: true, mode: 'worktree' });
	});
	it('a ro/scr request with declared repo writes falls back to worktree, never refuses', () => {
		for (const requested of ['shared-readonly', 'scratch'] as const) {
			expect(decideIsolation(intent({ writes: 'repo', requested }), ctx())).toMatchObject({ ok: true, mode: 'worktree' });
		}
	});
	it('never grants shared-write, for any input at all', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (d.ok) expect(d.mode).not.toBe('shared-write');
		}
	});
	it('never asks for a lock — nothing it grants takes one', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (d.ok) expect(d.acquire).toEqual([]);
		}
	});
	it('is pure: same inputs, same answer, inputs untouched', () => {
		for (const [i, c] of everyCase()) {
			const before = JSON.stringify([i, c]);
			expect(decideIsolation(i, c)).toEqual(decideIsolation(i, c));
			expect(JSON.stringify([i, c])).toBe(before);
		}
	});
});

describe('property 1 — it never refuses when a worktree would do', () => {
	it('the only refusals are an explicit shared-write request or a read-only role writing a repo', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (d.ok) continue;
			const ceilingRefusal = c.rungCeiling === 'readonly' && i.writes === 'repo';
			expect(i.requested === 'shared-write' || ceilingRefusal).toBe(true);
		}
	});
	it('with a write-capable rung, only requested shared-write is ever refused', () => {
		for (const [i, c] of everyCase()) {
			if (c.rungCeiling !== 'write') continue;
			expect(decideIsolation(i, c).ok).toBe(i.requested !== 'shared-write');
		}
	});
	it('every refusal names both a holder and a path', () => {
		for (const [i, c] of everyCase()) {
			const d = decideIsolation(i, c);
			if (d.ok) continue;
			expect(d.holder.trim()).not.toBe('');
			expect(d.path.trim()).not.toBe('');
			expect(d.reason.trim()).not.toBe('');
		}
	});
	it('a shared-write refusal with no claim names the setting as the holder, and the checkout', () => {
		const d = decideIsolation(intent({ requested: 'shared-write' }), ctx());
		expect(d).toMatchObject({ ok: false, holder: 'isolation setting "cheap-readonly"', path: 'C:/dev/app' });
	});
	it('a shared-write refusal names the live claim holder and its path when there is one', () => {
		const d = decideIsolation(intent({ requested: 'shared-write' }), ctx({ claims: [claim({ holder: 'fix-auth', path: 'C:/dev/app' })] }));
		expect(d).toMatchObject({ ok: false, holder: 'fix-auth', path: 'C:/dev/app' });
	});
});

describe('property 2 — it never widens a role', () => {
	it('a proposer asking for repo writes is refused, whatever the task class, naming role and path', () => {
		for (const taskClass of TASK_CLASSES) {
			for (const requested of REQUESTS) {
				const d = decideIsolation(intent({ taskClass, writes: 'repo', ...(requested ? { requested } : {}) }), ctx({ rungCeiling: 'readonly', role: 'researcher' }));
				expect(d.ok).toBe(false);
				if (d.ok) continue;
				if (requested !== 'shared-write') {
					expect(d.holder).toBe('researcher');
					expect(d.reason).toContain('researcher');
				}
				expect(d.path).toBe('C:/dev/app');
			}
		}
	});
	it('a read-only rung only ever gets shared-readonly or scratch, whatever it requests, under every policy', () => {
		for (const [i, c] of everyCase()) {
			if (c.rungCeiling !== 'readonly') continue;
			const d = decideIsolation(i, c);
			if (d.ok) expect(['shared-readonly', 'scratch']).toContain(d.mode);
		}
	});
	for (const policy of POLICIES) {
		describe(`under policy ${policy}`, () => {
			const ro = (o: Partial<IsolationIntent>) => decideIsolation(intent(o), ctx({ policy, rungCeiling: 'readonly', role: 'researcher' }));
			it('a proposer is never granted a worktree with repo writes — for any class or request', () => {
				for (const taskClass of TASK_CLASSES) for (const requested of REQUESTS) {
					const d = ro({ taskClass, writes: 'repo', ...(requested ? { requested } : {}) });
					expect(d.ok).toBe(false);
					if (!d.ok) expect(d.path).toBe('C:/dev/app');
					if (!d.ok && requested !== 'shared-write') expect(d.holder).toBe('researcher');
				}
			});
			it('a proposer is never granted a worktree at all', () => {
				for (const taskClass of TASK_CLASSES) for (const writes of WRITES) for (const requested of REQUESTS) {
					const d = ro({ taskClass, writes, ...(requested ? { requested } : {}) });
					if (d.ok) expect(d.mode).not.toBe('worktree');
				}
			});
			it('writes outside → scratch, writes none → shared-readonly', () => {
				expect(ro({ writes: 'outside' })).toMatchObject({ ok: true, mode: 'scratch' });
				expect(ro({ writes: 'none' })).toMatchObject({ ok: true, mode: 'shared-readonly' });
				expect(ro({ writes: 'none', requested: 'worktree' })).toMatchObject({ ok: true, mode: 'shared-readonly' });
			});
		});
	}
	it('a read-only rung requesting a worktree for a read gets shared-readonly', () => {
		expect(decideIsolation(intent({ writes: 'none', requested: 'worktree' }), ctx({ rungCeiling: 'readonly' }))).toMatchObject({ ok: true, mode: 'shared-readonly' });
	});
	it('a role-less refusal still names a holder', () => {
		const d = decideIsolation(intent({ writes: 'repo' }), ctx({ rungCeiling: 'readonly' }));
		expect(d).toMatchObject({ ok: false, holder: 'this role', path: 'C:/dev/app' });
	});
});

describe('property 3 — a stale claim counts as free, by the lockStatus rule', () => {
	it('live inside the TTL, stale past it — the boundary is the lockStatus one (now > ts + ttl)', () => {
		const c = claim({ ts: NOW, ttlMs: 1000 });
		expect(claimIsLive(c, NOW)).toBe(true);
		expect(claimIsLive(c, NOW + 1000)).toBe(true);
		expect(claimIsLive(c, NOW + 1001)).toBe(false);
	});
	it('agrees with coord-core.cjs lockStatus — the rule the CLI uses', () => {
		const core = require('../pty-sidecar/coord-core.cjs');
		for (const dt of [0, 1, 999, 1000, 1001, 10_000]) {
			const c = claim({ ts: NOW, ttlMs: 1000 });
			expect(claimIsLive(c, NOW + dt)).toBe(core.lockStatus(c, NOW + dt) === 'held');
		}
	});
	it('a stale claim on the checkout is not reported as its holder', () => {
		const stale = claim({ ts: NOW - 700_000, ttlMs: 600_000 });
		expect(liveClaimOn(checkout.id, [stale], NOW)).toBeNull();
		const d = decideIsolation(intent({ requested: 'shared-write' }), ctx({ claims: [stale] }));
		expect(d).toMatchObject({ ok: false, holder: 'isolation setting "cheap-readonly"' });
	});
	it('a claim on another checkout is ignored', () => {
		expect(liveClaimOn(checkout.id, [claim({ resource: writeResource('other') })], NOW)).toBeNull();
	});
	it('claims never change a grant at this step — a held checkout still yields the same lock-free answer', () => {
		for (const writes of WRITES) {
			expect(decideIsolation(intent({ writes }), ctx({ claims: [claim()] }))).toEqual(decideIsolation(intent({ writes }), ctx()));
		}
	});
});

describe('resolveIntent', () => {
	it('defaults the class to feature and its writes to repo', () => {
		expect(resolveIntent({}, checkout, 'write')).toEqual({ taskClass: 'feature', writes: 'repo', checkout });
	});
	it('derives writes from the class when undeclared (§8 table)', () => {
		expect(defaultWritesFor('investigate')).toBe('none');
		expect(defaultWritesFor('doc')).toBe('outside');
		for (const k of ['feature', 'small-fix', 'config', 'release'] as const) expect(defaultWritesFor(k)).toBe('repo');
		expect(resolveIntent({ taskClass: 'investigate' }, checkout, 'write').writes).toBe('none');
	});
	it('a read-only rung with undeclared writes reads as none — the rung declares it', () => {
		expect(resolveIntent({ taskClass: 'feature' }, checkout, 'readonly').writes).toBe('none');
		expect(resolveIntent({ taskClass: 'doc' }, checkout, 'readonly').writes).toBe('outside');
	});
	it('an explicit --writes repo is kept under a read-only rung, so it is refused, not narrowed', () => {
		const i = resolveIntent({ writes: 'repo' }, checkout, 'readonly');
		expect(i.writes).toBe('repo');
		expect(decideIsolation(i, ctx({ rungCeiling: 'readonly' })).ok).toBe(false);
	});
	it('junk reads as absent; case and whitespace are forgiven', () => {
		expect(resolveIntent({ taskClass: 'nope', writes: 7, requested: 'shared' }, checkout, 'write')).toEqual({ taskClass: 'feature', writes: 'repo', checkout });
		expect(resolveIntent({ taskClass: ' Investigate ', requested: 'SCRATCH' }, checkout, 'write')).toMatchObject({ taskClass: 'investigate', requested: 'scratch' });
	});
});

describe('rungCeilingOf — from the role file authority:', () => {
	it('observer and proposer are read-only', () => {
		expect(rungCeilingOf('observer')).toBe('readonly');
		expect(rungCeilingOf(' Proposer ')).toBe('readonly');
		expect(rungCeilingOf('`proposer`')).toBe('readonly');
	});
	it('operator, autonomous, absent and unknown are write-capable', () => {
		for (const a of ['operator', 'autonomous', '', undefined, 'whatever']) expect(rungCeilingOf(a)).toBe('write');
	});
});

describe('parseIsolationPolicy — config.json `isolation`, default worktree-always', () => {
	it('only cheap-readonly switches it on', () => {
		expect(parseIsolationPolicy('cheap-readonly')).toBe('cheap-readonly');
		expect(parseIsolationPolicy(' Cheap-Readonly ')).toBe('cheap-readonly');
		for (const v of [undefined, null, '', 'worktree-always', 'cheapest-safe', 42, {}]) expect(parseIsolationPolicy(v)).toBe('worktree-always');
	});
});

describe('modeChip', () => {
	it('maps each mode to its fixed text and variant', () => {
		expect(modeChip('worktree')).toMatchObject({ text: 'wt', variant: 'worktree' });
		expect(modeChip('shared-readonly')).toMatchObject({ text: 'ro', variant: 'default' });
		expect(modeChip('shared-write')).toMatchObject({ text: 'rw🔒', variant: 'lease' });
		expect(modeChip('scratch')).toMatchObject({ text: 'scr', variant: 'default' });
	});
	it('parseMode accepts only the four modes', () => {
		expect(parseMode('scratch')).toBe('scratch');
		expect(parseMode('rw')).toBeUndefined();
		expect(parseMode(undefined)).toBeUndefined();
	});
});

describe('isolation.jsonl records', () => {
	it('a grant records the mode and what the session got', () => {
		const i = intent({ writes: 'none' }); const c = ctx();
		const r = isolationRecord('app', i, c, decideIsolation(i, c), { sessionId: 's-9', cwd: 'C:/dev/app' });
		expect(r).toMatchObject({ v: 1, ts: NOW, repo: 'app', checkout: 'C:/dev/app', primary: true, taskClass: 'feature', writes: 'none', policy: 'cheap-readonly', rungCeiling: 'write', ok: true, mode: 'shared-readonly', sessionId: 's-9', cwd: 'C:/dev/app' });
		expect(r).not.toHaveProperty('holder');
	});
	it('a refusal records holder and path, and no mode', () => {
		const i = intent({ writes: 'repo' }); const c = ctx({ rungCeiling: 'readonly', role: 'researcher' });
		const r = isolationRecord('app', i, c, decideIsolation(i, c));
		expect(r).toMatchObject({ ok: false, holder: 'researcher', path: 'C:/dev/app', role: 'researcher' });
		expect(r).not.toHaveProperty('mode');
	});
	it('one newline-terminated JSON line that round-trips', () => {
		const i = intent(); const c = ctx();
		const r = isolationRecord('app', i, c, decideIsolation(i, c), { failed: 'git said no' });
		const line = formatIsolationLine(r);
		expect(line.endsWith('\n')).toBe(true);
		expect(line.slice(0, -1)).not.toContain('\n');
		expect(JSON.parse(line)).toEqual(r);
	});
});

describe('sessionMode — what the session row shows', () => {
	it('a recorded mode wins; an unrecorded worktree tile is wt; a plain folder has no chip', async () => {
		const { sessionMode } = await import('../src/core/isolation');
		expect(sessionMode('shared-readonly', true)).toBe('shared-readonly');
		expect(sessionMode('scratch', true)).toBe('scratch');
		expect(sessionMode(undefined, false)).toBe('worktree');
		expect(sessionMode(undefined, undefined)).toBe('worktree');
		expect(sessionMode(undefined, true)).toBeUndefined();
	});
	it('the chip uses only CSS custom properties app.css already defines', () => {
		const fs = require('node:fs'); const path = require('node:path');
		const css: string = fs.readFileSync(path.join(__dirname, '..', 'app.css'), 'utf8');
		const rules = css.split('\n').filter((l) => l.startsWith('.cos-mode-chip')).join('\n');
		const used = [...rules.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
		expect(used.length).toBeGreaterThan(0);
		for (const v of used) expect(css).toMatch(new RegExp(`^[ \\t]*${v}:`, 'm'));
		expect(rules).not.toMatch(/color-(green|red)/); // never a state colour
	});
});
