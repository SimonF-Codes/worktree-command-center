// `cos-coord lease` and `cos-coord lease release` (V2 step 9): a release is refused unless the
// checkout is clean, and refused loudly when this session holds nothing — never a silent exit 0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeSessionEnv } from '../src/terminals/session-env';
import { makeTempDir } from './temp-dir';
const require = createRequire(import.meta.url);
const claims = require('../pty-sidecar/claims-store.cjs');

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
let root: string, coordDir: string, claimsDir: string, repo: string;

function git(...args: string[]) { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); }
beforeEach(() => {
	root = makeTempDir('lease-cli-');
	coordDir = path.join(root, '.coordination', 'ws-1');
	fs.mkdirSync(coordDir, { recursive: true });
	claimsDir = claims.ensureClaimsDir(claims.claimsDirOf(coordDir));
	repo = path.join(root, 'app');
	fs.mkdirSync(repo);
	git('init', '-q');
	git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
	git('add', '.'); git('commit', '-qm', 'init');
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

function cli(args: string[], env: Record<string, string> = {}) {
	const r = spawnSync('node', [CLI, ...args], { env: { ...sanitizeSessionEnv(process.env), COS_COORD_DIR: coordDir, ...env }, encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}
const session = (id: string) => ({ COS_SESSION_ID: id, COS_CHECKOUT: repo, COS_TERMINAL_NAME: `t-${id}` });

describe('cos-coord lease', () => {
	it('lists the machine-wide leases, marking yours', () => {
		claims.takeClaim(claimsDir, repo, { sessionId: 's1', holder: 'fix-auth', mode: 'shared-write' });
		const r = cli(['lease'], session('s1'));
		expect(r.code).toBe(0);
		expect(r.out).toContain('fix-auth');
		expect(r.out).toContain('[yours]');
		expect(cli(['lease'], session('s2')).out).not.toContain('[yours]');
	});
	it('status lists them too', () => {
		claims.takeClaim(claimsDir, repo, { sessionId: 's1', holder: 'fix-auth', mode: 'shared-write' });
		expect(cli(['status']).out).toMatch(/write lease .* — fix-auth/);
	});
	it('release from a clean checkout gives it up (exit 0)', () => {
		claims.takeClaim(claimsDir, repo, { sessionId: 's1', holder: 'fix-auth' });
		const r = cli(['lease', 'release'], session('s1'));
		expect(r.code).toBe(0);
		expect(claims.readClaims(claimsDir)).toHaveLength(0);
	});
	it('release from a dirty checkout is refused (exit 2) and the lease is kept — a shell write gets noticed here', () => {
		claims.takeClaim(claimsDir, repo, { sessionId: 's1', holder: 'fix-auth' });
		fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by a shell redirect\n');
		const r = cli(['lease', 'release'], session('s1'));
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/refused/);
		expect(r.err).toContain('a.txt');
		expect(claims.readClaims(claimsDir)).toHaveLength(1);
	});
	it('release by a session that holds nothing fails loudly (exit 2), and touches nothing', () => {
		claims.takeClaim(claimsDir, repo, { sessionId: 's1', holder: 'fix-auth' });
		const r = cli(['lease', 'release'], session('s2'));
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/holds no write lease/);
		expect(claims.readClaims(claimsDir)[0].sessionId).toBe('s1');
	});
	it('release outside an app session fails loudly instead of exiting 0', () => {
		const r = spawnSync('node', [CLI, 'lease', 'release'], { env: sanitizeSessionEnv(process.env), encoding: 'utf8' });
		expect(r.status).toBe(2);
	});
});
