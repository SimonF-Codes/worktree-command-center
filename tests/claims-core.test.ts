// The write gate's decision (V2 step 9) — pure, so every case is data. The hook that runs it is
// exercised end to end, as processes, in claims-collision.test.ts.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { WORKTREES_DIR } from '../src/terminals/worktree-manager';
const require = createRequire(import.meta.url);
const cc = require('../pty-sidecar/claims-core.cjs');
const core = require('../pty-sidecar/coord-core.cjs');

const NOW = 10_000_000;
const APP = path.resolve('C:/dev/app');
const at = (...p: string[]) => path.join(APP, ...p);
const claim = (o: Record<string, unknown> = {}) => ({ resource: `write:${cc.checkoutId(APP)}`, checkoutId: cc.checkoutId(APP), path: APP, sessionId: 'other', holder: 'fix-auth', mode: 'shared-write', ts: NOW - 60_000, ttlMs: cc.CLAIM_TTL_MS, ...o });
const base = { checkout: APP, sessionId: 'me', claims: [] as unknown[], now: NOW, policy: 'cheap-readonly', rung: 'write', taskClass: 'investigate' };
const decide = (o: Record<string, unknown>) => cc.decideWrite({ ...base, target: at('src', 'x.ts'), ...o });

describe('names', () => {
	it('the nested worktree root matches the app\'s (drift)', () => { expect(cc.WORKTREES_DIR).toBe(WORKTREES_DIR); });
	it('the lease lives as long as the automatic git locks', () => { expect(cc.CLAIM_TTL_MS).toBe(core.GIT_TTL_MS); });
	// One path written several ways collapsing to one id is the property; which spellings exist is
	// the platform's business. A drive-letter path with backslashes is one path on Windows and a
	// legal RELATIVE FILENAME on Linux, where path.resolve prefixes the cwd and the two spellings
	// become genuinely different checkouts. So the drive-letter case is asserted on Windows only,
	// and the case / separator / trailing-slash property is asserted everywhere — CI runs
	// ubuntu-latest, where this assertion failed on 2026-11-22 (run 45062441421).
	it.runIf(process.platform === 'win32')('checkoutId collapses Windows spellings: drive case, separators, trailing slash', () => {
		expect(cc.checkoutId('C:\\Dev\\App\\')).toBe(cc.checkoutId('c:/dev/app'));
		expect(cc.checkoutId('C:/dev/app')).not.toMatch(/\\/);
	});
	it('checkoutId: resolved, forward slashes, lower case — one spelling for every way to write it', () => {
		const p = path.resolve(path.sep + 'dev', 'App');
		expect(cc.checkoutId(p + path.sep)).toBe(cc.checkoutId(p.toLowerCase()));
		expect(cc.checkoutId(p)).not.toMatch(/\\/);
	});
	it('isInside is separator-bounded', () => {
		expect(cc.isInside(at('a.ts'), APP)).toBe(true);
		expect(cc.isInside(APP, APP)).toBe(true);
		expect(cc.isInside(APP + '2', APP)).toBe(false);
	});
	it('a lease covers its checkout but not the nested worktree root (Q9: lenient)', () => {
		expect(cc.claimCovers(claim(), at('src', 'x.ts'))).toBe(true);
		expect(cc.claimCovers(claim(), at(WORKTREES_DIR, 'wt-main-1', 'src', 'x.ts'))).toBe(false);
	});
	it('toolTarget: Edit/Write file_path, NotebookEdit notebook_path, relative paths resolved against cwd', () => {
		expect(cc.toolTarget({ tool_input: { file_path: at('a.ts') } })).toBe(at('a.ts'));
		expect(cc.toolTarget({ tool_input: { notebook_path: at('n.ipynb') } })).toBe(at('n.ipynb'));
		expect(cc.toolTarget({ cwd: APP, tool_input: { file_path: 'rel/b.ts' } })).toBe(at('rel', 'b.ts'));
		expect(cc.toolTarget({ tool_input: {} })).toBe('');
	});
});

describe('decideWrite — someone else\'s live lease', () => {
	it('denies any session, in any mode, naming the holder and the path (FR-17)', () => {
		for (const mode of [undefined, 'worktree', 'shared-readonly', 'shared-write', 'scratch']) {
			const d = decide({ mode, claims: [claim()] });
			expect(d).toMatchObject({ verdict: 'deny', holder: 'fix-auth', path: APP });
			expect(d.reason).toContain('fix-auth');
			expect(d.reason).toContain(APP);
		}
	});
	it('the denial says what to do: stop, no shell workaround, respawn in a worktree', () => {
		const d = decide({ mode: 'shared-write', claims: [claim()] });
		expect(d.reason).toMatch(/shell command/);
		expect(d.reason).toMatch(/respawned in its own worktree/);
	});
	it('a stale lease does not deny — a dead holder blocks nobody', () => {
		expect(decide({ mode: 'worktree', claims: [claim({ ts: NOW - cc.CLAIM_TTL_MS - 1 })] })).toEqual({ verdict: 'allow' });
	});
	it('a worktree session writing in its own nested worktree is not covered by the primary\'s lease', () => {
		const wt = at(WORKTREES_DIR, 'wt-main-1');
		expect(cc.decideWrite({ ...base, mode: 'worktree', checkout: wt, target: path.join(wt, 'a.ts'), claims: [claim()] })).toEqual({ verdict: 'allow' });
	});
	it('my own lease never denies me', () => {
		expect(decide({ mode: 'shared-write', claims: [claim({ sessionId: 'me' })] })).toEqual({ verdict: 'claim', escalate: false });
	});
});

describe('decideWrite — the session\'s own checkout', () => {
	it('worktree / no mode: allow (its checkout is its own)', () => {
		expect(decide({ mode: 'worktree' })).toEqual({ verdict: 'allow' });
		expect(decide({ mode: undefined })).toEqual({ verdict: 'allow' });
	});
	it('shared-write: claim (take or renew the lease), then allow', () => {
		expect(decide({ mode: 'shared-write' })).toEqual({ verdict: 'claim', escalate: false });
	});
	it('shared-readonly under cheap-readonly: denied, and told to stop and be respawned', () => {
		const d = decide({ mode: 'shared-readonly' });
		expect(d).toMatchObject({ verdict: 'deny', path: APP });
		expect(d.reason).toMatch(/shared-readonly/);
		expect(d.reason).toMatch(/respawned with its own worktree/);
	});
	it('shared-readonly under cheapest-safe: escalates at the moment of the write (FR-16)', () => {
		expect(decide({ mode: 'shared-readonly', policy: 'cheapest-safe' })).toEqual({ verdict: 'claim', escalate: true });
	});
	it('never escalates a read-only rung, a feature, or an unknown/absent rung', () => {
		expect(decide({ mode: 'shared-readonly', policy: 'cheapest-safe', rung: 'readonly' }).verdict).toBe('deny');
		expect(decide({ mode: 'shared-readonly', policy: 'cheapest-safe', rung: undefined }).verdict).toBe('deny');
		expect(decide({ mode: 'shared-readonly', policy: 'cheapest-safe', taskClass: 'feature' }).verdict).toBe('deny');
		expect(decide({ mode: 'shared-readonly', policy: 'cheapest-safe', taskClass: undefined }).verdict).toBe('deny');
	});
	it('scratch: never inside the checkout it came from', () => {
		expect(decide({ mode: 'scratch' })).toMatchObject({ verdict: 'deny', path: APP });
	});
	it('a shared session may not write into a nested worktree — another session\'s', () => {
		for (const mode of ['shared-readonly', 'shared-write', 'scratch']) {
			expect(decide({ mode, policy: 'cheapest-safe', target: at(WORKTREES_DIR, 'wt-main-1', 'a.ts') }).verdict).toBe('deny');
		}
	});
	it('outside the checkout no lease applies (a scratchpad, a vault note)', () => {
		for (const mode of ['shared-readonly', 'shared-write', 'scratch']) {
			expect(decide({ mode, target: path.resolve('C:/Users/me/scratch/notes.md') })).toEqual({ verdict: 'allow' });
		}
	});
	it('a shared session with no checkout recorded is denied, not guessed', () => {
		expect(decide({ mode: 'shared-write', checkout: '' }).verdict).toBe('deny');
	});
});

describe('releaseRefusal: the clean-tree release', () => {
	it('clean → no refusal', () => { expect(cc.releaseRefusal('', APP)).toBeNull(); expect(cc.releaseRefusal('\n', APP)).toBeNull(); });
	it('dirty → refused, naming the files', () => {
		const r = cc.releaseRefusal(' M src/a.ts\n?? new.txt\n', APP);
		expect(r).toMatch(/2 uncommitted changes/);
		expect(r).toContain('src/a.ts');
	});
	it('git could not be asked → refused: an unknown tree is not a clean one', () => { expect(cc.releaseRefusal(null, APP)).toMatch(/git status failed/); });
});
