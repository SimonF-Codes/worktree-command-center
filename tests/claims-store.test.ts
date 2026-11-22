// The machine-wide claim store (V2 step 9, section 1): one file per checkout root, on the same
// `wx` acquire as every coordination lock, with the stable sessionId, the mode, and a lease.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTempDir } from './temp-dir';
const require = createRequire(import.meta.url);
const claims = require('../pty-sidecar/claims-store.cjs');
const cc = require('../pty-sidecar/claims-core.cjs');
const core = require('../pty-sidecar/coord-core.cjs');

let root: string;
let dir: string;
let board: string;
const checkout = 'C:/dev/app';
const who = (sessionId: string, holder = `t-${sessionId}`) => ({ sessionId, holder, mode: 'shared-write', reason: 'fix' });
beforeEach(() => {
	root = makeTempDir('claims-');
	dir = claims.ensureClaimsDir(path.join(root, '_claims'));
	board = path.join(root, 'ws-1');
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('where: machine-wide, beside the per-workspace directories (E1)', () => {
	it('claimsDirOf is the sibling _claims/ of any workspace coordination dir', () => {
		const a = claims.claimsDirOf(path.join(root, '.coordination', 'ws-a'));
		const b = claims.claimsDirOf(path.join(root, '.coordination', 'ws-b'));
		expect(a).toBe(b);
		expect(a).toBe(path.join(root, '.coordination', '_claims'));
	});
	it('one file per checkout root, named by sha1 of the id — never a slug', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000 });
		const files = fs.readdirSync(dir);
		expect(files).toEqual([cc.claimFileName(cc.checkoutId(checkout))]);
		expect(files[0]).toMatch(/^write-[0-9a-f]{40}\.json$/);
		// Two checkouts a slug would collapse into one name get two files.
		expect(cc.claimFileName(cc.checkoutId('C:/dev/a-b'))).not.toBe(cc.claimFileName(cc.checkoutId('C:/dev/a_b')));
	});
});

describe('who: the stable sessionId and the mode (E2)', () => {
	it('the payload carries sessionId, holder, mode, the readable path and a lease', () => {
		claims.takeClaim(dir, checkout, who('s1', 'fix-auth'), { now: 1000 });
		const [c] = claims.readClaims(dir);
		expect(c).toMatchObject({ sessionId: 's1', holder: 'fix-auth', mode: 'shared-write', path: path.resolve(checkout), resource: `write:${cc.checkoutId(checkout)}`, ts: 1000, ttlMs: cc.CLAIM_TTL_MS });
	});
});

describe('takeClaim', () => {
	it('exactly one session gets a free checkout; the other is told who holds it', () => {
		expect(claims.takeClaim(dir, checkout, who('s1'), { now: 1000 })).toEqual({ ok: true, acquired: true });
		const r = claims.takeClaim(dir, checkout, who('s2'), { now: 2000 });
		expect(r.ok).toBe(false);
		expect(r.holder).toMatchObject({ sessionId: 's1', holder: 't-s1' });
	});
	it('is re-entrant: the holder taking it again renews instead of failing', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000 });
		expect(claims.takeClaim(dir, checkout, who('s1'), { now: 5000 })).toEqual({ ok: true, renewed: true });
		expect(claims.readClaims(dir)[0].ts).toBe(5000);
	});
	it('a stale lease is reclaimable — by the rule lockStatus already uses', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000, ttlMs: 1000 });
		expect(core.lockStatus(claims.readClaims(dir)[0], 2001)).toBe('stale');
		expect(claims.takeClaim(dir, checkout, who('s2'), { now: 2001 })).toEqual({ ok: true, acquired: true });
		expect(claims.readClaims(dir)[0].sessionId).toBe('s2');
	});
	it('a lease exactly at its TTL is still live', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000, ttlMs: 1000 });
		expect(claims.takeClaim(dir, checkout, who('s2'), { now: 2000 }).ok).toBe(false);
	});
	it('different checkouts never contend', () => {
		expect(claims.takeClaim(dir, 'C:/dev/app', who('s1')).ok).toBe(true);
		expect(claims.takeClaim(dir, 'C:/dev/other', who('s2')).ok).toBe(true);
	});
	// Windows spellings only collapse on Windows: on Linux a drive-letter path with backslashes is
	// a relative filename, so path.resolve makes it a different checkout and the second take
	// succeeds. The platform-independent half of the same property is the case fold, which
	// claims-core applies on every platform on purpose — over-exclusion is the safe direction.
	it.runIf(process.platform === 'win32')('the same checkout spelled differently is the same claim (Windows spellings)', () => {
		claims.takeClaim(dir, 'C:\\dev\\App\\', who('s1'));
		expect(claims.takeClaim(dir, 'c:/dev/app', who('s2')).ok).toBe(false);
	});
	it('a checkout differing only in case is the same claim — checkoutId lower-cases everywhere', () => {
		const mixed = path.resolve(path.sep + 'dev', 'App');
		expect(claims.takeClaim(dir, mixed, who('s1')).ok).toBe(true);
		expect(claims.takeClaim(dir, mixed.toLowerCase(), who('s2')).ok).toBe(false);
	});
	it('writes START to the workspace board feed when it acquires, not when it renews', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000, boardDir: board });
		claims.takeClaim(dir, checkout, who('s1'), { now: 2000, boardDir: board });
		const lines = fs.readFileSync(path.join(board, 'board.md'), 'utf8').trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(core.parseBoardLine(lines[0])).toMatchObject({ status: 'START', resource: `write:${path.resolve(checkout)}` });
	});
	it('throws (it never creates the directory) when the store is missing — the caller decides', () => {
		expect(() => claims.takeClaim(path.join(root, 'nope'), checkout, who('s1'))).toThrow();
		expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);
	});
});

describe('the lease: renewClaim re-stamps, and only for its holder', () => {
	it('renews its own claim', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000 });
		expect(claims.renewClaim(dir, checkout, 's1', { now: 9000 })).toBe(true);
		expect(claims.readClaims(dir)[0].ts).toBe(9000);
	});
	it('never renews someone else\'s — a takeover is not overwritten', () => {
		claims.takeClaim(dir, checkout, who('s1'), { now: 1000, ttlMs: 1000 });
		claims.takeClaim(dir, checkout, who('s2'), { now: 5000 }); // s1 went stale, s2 took it
		expect(claims.renewClaim(dir, checkout, 's1', { now: 6000 })).toBe(false);
		expect(claims.readClaims(dir)[0]).toMatchObject({ sessionId: 's2', ts: 5000 });
	});
	it('a renewal leaves no temp or guard file behind', () => {
		claims.takeClaim(dir, checkout, who('s1'));
		claims.renewClaim(dir, checkout, 's1');
		expect(fs.readdirSync(dir)).toHaveLength(1);
	});
});

describe('release', () => {
	it('only the holder releases; DONE is written to the feed', () => {
		claims.takeClaim(dir, checkout, who('s1'), { boardDir: board });
		expect(claims.releaseClaim(dir, checkout, 's2', { boardDir: board })).toBeNull();
		expect(claims.releaseClaim(dir, checkout, 's1', { boardDir: board })).toMatchObject({ sessionId: 's1' });
		expect(claims.readClaims(dir)).toHaveLength(0);
		const lines = fs.readFileSync(path.join(board, 'board.md'), 'utf8').trim().split('\n');
		expect(core.parseBoardLine(lines[lines.length - 1]).status).toBe('DONE');
	});
	it('claimsOf lists every lease one session holds', () => {
		claims.takeClaim(dir, 'C:/dev/a', who('s1'));
		claims.takeClaim(dir, 'C:/dev/b', who('s1'));
		claims.takeClaim(dir, 'C:/dev/c', who('s2'));
		expect(claims.claimsOf(dir, 's1').map((c: { path: string }) => c.path).sort()).toEqual([path.resolve('C:/dev/a'), path.resolve('C:/dev/b')]);
	});
});

describe('readClaims: strict for a gate, lenient for a display', () => {
	it('lenient: a missing directory is no claims, a bad file is skipped', () => {
		expect(claims.readClaims(path.join(root, 'missing'))).toEqual([]);
		claims.takeClaim(dir, checkout, who('s1'));
		fs.writeFileSync(path.join(dir, `write-${'0'.repeat(40)}.json`), '{ not json');
		expect(claims.readClaims(dir)).toHaveLength(1);
	});
	it('strict: a missing directory throws', () => {
		expect(() => claims.readClaims(path.join(root, 'missing'), { strict: true })).toThrow();
	});
	it('strict: an unreadable claim file throws — it could be the one that matters', () => {
		fs.writeFileSync(path.join(dir, `write-${'0'.repeat(40)}.json`), '{ not json');
		expect(() => claims.readClaims(dir, { strict: true })).toThrow(/unreadable/);
	});
	it('ignores guard, temp and foreign files', () => {
		claims.takeClaim(dir, checkout, who('s1'));
		fs.writeFileSync(path.join(dir, 'x.json.guard'), '1');
		fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
		expect(claims.readClaims(dir, { strict: true })).toHaveLength(1);
	});
});

describe('remapClaims (a repo move): the path and the file name move together', () => {
	it('re-points a claim inside a moved directory, and renames its file', () => {
		claims.takeClaim(dir, 'C:/dev/app', who('s1'), { now: 1000 });
		const r = claims.remapClaims(dir, (p: string) => (cc.isInside(p, 'C:/dev/app') ? path.join('C:/code/app', path.relative(path.resolve('C:/dev/app'), path.resolve(p))) : p));
		expect(r).toEqual({ changed: 1, conflicts: [] });
		const [c] = claims.readClaims(dir);
		expect(c).toMatchObject({ path: path.resolve('C:/code/app'), checkoutId: cc.checkoutId('C:/code/app'), sessionId: 's1', ts: 1000 });
		expect(fs.readdirSync(dir)).toEqual([cc.claimFileName(cc.checkoutId('C:/code/app'))]);
	});
	it('leaves claims the move did not touch exactly as they were', () => {
		claims.takeClaim(dir, 'C:/dev/other', who('s1'));
		expect(claims.remapClaims(dir, (p: string) => p)).toEqual({ changed: 0, conflicts: [] });
	});
});
