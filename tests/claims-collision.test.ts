// THE COLLISION SUITE — V2 step 9's acceptance gate: two fake sessions, one checkout, green.
//
// Not a unit test of decideIsolation. Everything here runs the real thing as separate processes —
// the write hook (`coord-hook.cjs --write`, exactly as Claude Code runs it, hook JSON on stdin and
// the session's COS_* environment) and the claim store — against one real `_claims/` directory
// and one real checkout directory. Contention is real contention: processes released at the same
// instant racing for the same `wx` create.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decideIsolation, resolveIntent, claimOf, checkoutIdOf, redecideAfterLostRace, type IsolationContext } from '../src/core/isolation';
import { makeTempDir } from './temp-dir';
const require = createRequire(import.meta.url);
const claims = require('../pty-sidecar/claims-store.cjs');
const cc = require('../pty-sidecar/claims-core.cjs');

vi.setConfig({ testTimeout: 60_000 }); // dozens of node processes; generous on a loaded machine

const HOOK = path.join(__dirname, '..', 'pty-sidecar', 'coord-hook.cjs');
const STORE = path.join(__dirname, '..', 'pty-sidecar', 'claims-store.cjs');

let root: string, coordDir: string, claimsDir: string, checkout: string, scriptDir: string;
beforeEach(() => {
	root = makeTempDir('collision-');
	coordDir = path.join(root, '.coordination', 'ws-1');
	fs.mkdirSync(coordDir, { recursive: true });
	claimsDir = claims.ensureClaimsDir(claims.claimsDirOf(coordDir));
	checkout = path.join(root, 'app'); // the ONE checkout both sessions want
	fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
	scriptDir = path.join(root, 'scripts');
	fs.mkdirSync(scriptDir);
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } });

// ---- A fake session: its environment, as the app's tile sets it (core/isolation writeGateEnv).
interface Session { id: string; name: string; mode?: string; checkout: string; policy?: string; rung?: string; taskClass?: string; claimsDir?: string }
const rw = (id: string, name = id): Session => ({ id, name, mode: 'shared-write', checkout, policy: 'cheapest-safe', rung: 'write', taskClass: 'small-fix' });
const ro = (id: string, o: Partial<Session> = {}): Session => ({ id, name: id, mode: 'shared-readonly', checkout, policy: 'cheap-readonly', rung: 'write', taskClass: 'investigate', ...o });

function envOf(s: Session): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('COS_')) env[k] = v;
	Object.assign(env, { COS_COORD_DIR: coordDir, COS_SESSION_ID: s.id, COS_TERMINAL_NAME: s.name, COS_CLAIMS_DIR: s.claimsDir ?? claimsDir });
	if (s.mode) Object.assign(env, { COS_ISOLATION: s.mode, COS_CHECKOUT: s.checkout });
	if (s.policy) env.COS_ISOLATION_POLICY = s.policy;
	if (s.rung) env.COS_RUNG = s.rung;
	if (s.taskClass) env.COS_TASK_CLASS = s.taskClass;
	return env;
}
const toolInput = (file: string, tool = 'Write') => JSON.stringify({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file, new_source: 'x' } : { file_path: file, content: 'x' }, cwd: checkout });

interface Verdict { allowed: boolean; reason: string; code: number | null }
function parse(stdout: string, code: number | null): Verdict {
	const out = stdout.trim();
	if (!out) return { allowed: true, reason: '', code };
	const j = JSON.parse(out);
	return { allowed: j.hookSpecificOutput.permissionDecision !== 'deny', reason: j.hookSpecificOutput.permissionDecisionReason, code };
}
/** One PreToolUse of a file tool, as Claude Code runs the hook. */
function write(s: Session, file = path.join(checkout, 'src', 'x.ts'), tool = 'Write'): Verdict {
	const r = spawnSync('node', [HOOK, '--write'], { input: toolInput(file, tool), env: envOf(s), encoding: 'utf8' });
	return parse(r.stdout, r.status);
}
/** The PostToolUse after it: re-stamps the lease. */
function renew(s: Session, file = path.join(checkout, 'src', 'x.ts')): void {
	spawnSync('node', [HOOK, '--write', '--renew'], { input: toolInput(file), env: envOf(s), encoding: 'utf8' });
}
function writeAsync(s: Session, file = path.join(checkout, 'src', 'x.ts')): Promise<Verdict> {
	return new Promise((resolve, reject) => {
		const c = spawn('node', [HOOK, '--write'], { env: envOf(s) });
		let out = '';
		c.stdout.on('data', (d) => { out += d; });
		c.on('error', reject);
		c.on('close', (code) => { try { resolve(parse(out, code)); } catch (e) { reject(e); } });
		c.stdin.end(toolInput(file));
	});
}
const holder = () => { const all = claims.readClaims(claimsDir); expect(all.length).toBeLessThanOrEqual(1); return all[0]; };
const age = (ms: number) => claims.renewClaim(claimsDir, checkout, holder().sessionId, { now: Date.now() - ms });

// ---- 1. The race itself.

/** A contender process: blocks until `startAt` (so all of them hit the store in the same
 *  millisecond window), then takes the lease through the real store, and reports. */
function contenderScript(): string {
	const f = path.join(scriptDir, 'contender.cjs');
	fs.writeFileSync(f, `
const claims = require(${JSON.stringify(STORE)});
const [dir, checkout, id, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* spin: a barrier */ }
let r; try { r = claims.takeClaim(dir, checkout, { sessionId: id, holder: id, mode: 'shared-write' }); } catch (e) { r = { error: e.message }; }
process.stdout.write(JSON.stringify(r));
`);
	return f;
}
function race(ids: string[]): Promise<{ id: string; r: { ok?: boolean; acquired?: boolean; error?: string; holder?: { sessionId: string } } }[]> {
	const script = contenderScript();
	const startAt = Date.now() + 700; // long enough for every process to boot and reach the barrier
	return Promise.all(ids.map((id) => new Promise<{ id: string; r: never }>((resolve, reject) => {
		const c = spawn('node', [script, claimsDir, checkout, id, String(startAt)]);
		let out = '';
		c.stdout.on('data', (d) => { out += d; });
		c.on('error', reject);
		c.on('close', () => { try { resolve({ id, r: JSON.parse(out) }); } catch (e) { reject(new Error(`contender ${id} printed ${JSON.stringify(out)}`)); } });
	})));
}

describe('the race: sessions released at the same instant, one checkout', () => {
	it('two sessions both want shared-write: exactly one gets it, every round (20 rounds)', async () => {
		for (let round = 0; round < 20; round++) {
			for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f));
			const results = await race([`a${round}`, `b${round}`]);
			const winners = results.filter((x) => x.r.ok);
			expect(results.every((x) => !x.r.error), JSON.stringify(results)).toBe(true);
			expect(winners, `round ${round}: ${JSON.stringify(results)}`).toHaveLength(1);
			const loser = results.find((x) => !x.r.ok)!;
			expect(loser.r.holder!.sessionId).toBe(winners[0]!.id); // the loser is told WHO won
			expect(holder().sessionId).toBe(winners[0]!.id);
		}
	});
	it('six sessions at once: still exactly one (5 rounds)', async () => {
		for (let round = 0; round < 5; round++) {
			for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f));
			const results = await race(['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => `${s}-${round}`));
			expect(results.filter((x) => x.r.ok), JSON.stringify(results)).toHaveLength(1);
			expect(claims.readClaims(claimsDir)).toHaveLength(1);
		}
	});
	it('six sessions racing for a STALE lease: exactly one takes it over — the guard holds (5 rounds)', async () => {
		for (let round = 0; round < 5; round++) {
			for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f));
			claims.takeClaim(claimsDir, checkout, { sessionId: 'dead', holder: 'dead' }, { now: Date.now() - cc.CLAIM_TTL_MS - 60_000 });
			const results = await race(['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => `${s}-${round}`));
			const winners = results.filter((x) => x.r.ok);
			expect(winners, JSON.stringify(results)).toHaveLength(1);
			expect(holder().sessionId).toBe(winners[0]!.id);
			expect(fs.readdirSync(claimsDir).filter((f) => !/^write-[0-9a-f]{40}\.json$/.test(f))).toEqual([]); // no guard or temp left behind
		}
	});
	it('two shared-write sessions\' first writes, through the hook, concurrently: exactly one allowed (10 rounds)', async () => {
		for (let round = 0; round < 10; round++) {
			for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f));
			const [a, b] = await Promise.all([writeAsync(rw(`A${round}`, 'fix-auth')), writeAsync(rw(`B${round}`, 'fix-typo'))]);
			expect([a, b].filter((v) => v.allowed), JSON.stringify([a, b])).toHaveLength(1);
			const lost = a.allowed ? b : a;
			expect(lost.reason).toContain(a.allowed ? 'fix-auth' : 'fix-typo');
			expect(lost.reason).toContain(checkout);
		}
	});
});

// ---- 2. Sequential contention: who is refused, and what they are told.

describe('two sessions, one checkout, one after the other', () => {
	it('the first write takes the lease; the second session is refused BY NAME AND PATH (FR-17)', () => {
		expect(write(rw('A', 'fix-auth')).allowed).toBe(true);
		expect(holder()).toMatchObject({ sessionId: 'A', holder: 'fix-auth', path: checkout });
		const b = write(rw('B', 'fix-typo'));
		expect(b.allowed).toBe(false);
		expect(b.reason).toContain('fix-auth');
		expect(b.reason).toContain(checkout);
	});
	it('the refusal tells the loser what to do: stop, no shell workaround, respawn in a worktree', () => {
		write(rw('A', 'fix-auth'));
		const b = write(rw('B'));
		expect(b.reason).toMatch(/Do not work around this with a shell command/);
		expect(b.reason).toMatch(/respawned in its own worktree/);
	});
	it('the holder keeps writing: every file, every file tool — Edit, Write, MultiEdit, NotebookEdit', () => {
		for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(write(rw('A'), path.join(checkout, 'src', `f.${tool}`), tool).allowed).toBe(true);
		for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(write(rw('B'), path.join(checkout, 'src', `f.${tool}`), tool).allowed).toBe(false);
	});
	it('a LIVE lease is not reclaimable — even a minute short of its TTL', () => {
		write(rw('A', 'fix-auth'));
		age(cc.CLAIM_TTL_MS - 60_000);
		expect(write(rw('B')).allowed).toBe(false);
		expect(holder().sessionId).toBe('A');
	});
	it('a STALE lease is reclaimable: the dead holder blocks nobody, and gets the refusal next', () => {
		write(rw('A', 'fix-auth'));
		age(cc.CLAIM_TTL_MS + 1000); // A stopped writing (died, or went quiet) more than a TTL ago
		expect(write(rw('B', 'fix-typo')).allowed).toBe(true);
		expect(holder()).toMatchObject({ sessionId: 'B', holder: 'fix-typo' });
		const a = write(rw('A', 'fix-auth'));
		expect(a.allowed).toBe(false);
		expect(a.reason).toContain('fix-typo');
	});
	it('renewal: the PostToolUse re-stamp keeps a working holder\'s lease alive', () => {
		write(rw('A'));
		age(cc.CLAIM_TTL_MS - 5000); // nearly stale...
		renew(rw('A')); // ...then A writes again
		expect(Date.now() - holder().ts).toBeLessThan(5000);
		expect(write(rw('B')).allowed).toBe(false);
	});
	it('a non-holder\'s PostToolUse never re-stamps someone else\'s lease', () => {
		write(rw('A'));
		age(cc.CLAIM_TTL_MS + 1000);
		const staleTs = holder().ts;
		renew(rw('B'));
		expect(holder()).toMatchObject({ sessionId: 'A', ts: staleTs });
	});
	it('after the holder releases (clean checkout), the other session can write', () => {
		write(rw('A'));
		expect(claims.releaseClaim(claimsDir, checkout, 'A')).not.toBeNull();
		expect(write(rw('B')).allowed).toBe(true);
	});
	it('two different checkouts never contend', () => {
		const other = path.join(root, 'other');
		fs.mkdirSync(other);
		expect(write(rw('A')).allowed).toBe(true);
		expect(write({ ...rw('B'), checkout: other }, path.join(other, 'y.ts')).allowed).toBe(true);
	});
	it('one lease per checkout ROOT: a write deep inside is covered by the root\'s lease', () => {
		write(rw('A', 'fix-auth'));
		expect(write(rw('B'), path.join(checkout, 'a', 'b', 'c', 'd.ts')).allowed).toBe(false);
	});
});

// ---- 3. shared-readonly is TRUE now (the more important half of this step).

describe('shared-readonly: enforced, not announced', () => {
	it('under cheap-readonly a ro session\'s write is denied, and told what to do', () => {
		const r = write(ro('R'));
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/shared-readonly/);
		expect(r.reason).toMatch(/Stop and say the task needs a write; it must be respawned with its own worktree/);
		expect(claims.readClaims(claimsDir)).toHaveLength(0); // and it took nothing
	});
	it('a ro session of a read-only rung is denied under every policy', () => {
		for (const policy of ['worktree-always', 'cheap-readonly', 'cheapest-safe']) expect(write(ro('R', { policy, rung: 'readonly' })).allowed).toBe(false);
	});
	it('a ro session from a record with no rung or class (pre-step-9) never escalates', () => {
		expect(write(ro('R', { policy: 'cheapest-safe', rung: undefined, taskClass: undefined })).allowed).toBe(false);
	});
	it('a ro feature session never escalates — feature work needs its own branch', () => {
		expect(write(ro('R', { policy: 'cheapest-safe', taskClass: 'feature' })).allowed).toBe(false);
	});
	it('a ro session may write OUTSIDE its checkout (its scratchpad, a vault note)', () => {
		const elsewhere = path.join(root, 'scratchpad', 'notes.md');
		expect(write(ro('R'), elsewhere).allowed).toBe(true);
	});
	it('a scratch session is denied inside the checkout it came from', () => {
		const r = write({ id: 'S', name: 'S', mode: 'scratch', checkout, policy: 'cheapest-safe', rung: 'write', taskClass: 'doc' });
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/scratch/);
	});
});

describe('FR-16: escalation at the moment of the write (cheapest-safe)', () => {
	it('the first ro session to write gets the lease; the second ro session is refused naming it', () => {
		expect(write(ro('R1', { policy: 'cheapest-safe', name: 'look-at-auth' })).allowed).toBe(true);
		expect(holder()).toMatchObject({ sessionId: 'R1', holder: 'look-at-auth' });
		const r2 = write(ro('R2', { policy: 'cheapest-safe' }));
		expect(r2.allowed).toBe(false);
		expect(r2.reason).toContain('look-at-auth');
	});
	it('an escalated ro session and a shared-write session exclude each other, both ways round', () => {
		write(ro('R1', { policy: 'cheapest-safe' }));
		expect(write(rw('W')).allowed).toBe(false);
		claims.releaseClaim(claimsDir, checkout, 'R1');
		write(rw('W'));
		expect(write(ro('R1', { policy: 'cheapest-safe' })).allowed).toBe(false);
	});
});

// ---- 4. The failure policy, under contention's own conditions.

describe('fail closed for a shared session, fail open for a worktree — the same broken store', () => {
	const broken = () => { const f = path.join(root, 'claims-is-a-file'); fs.writeFileSync(f, 'x'); return f; };
	it('an unreadable store DENIES a shared-write session\'s write', () => {
		const r = write({ ...rw('A'), claimsDir: broken() });
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/could not be read/);
		expect(r.code).toBe(0); // a JSON deny, not a crash Claude Code would read as non-blocking
	});
	it('a deleted store DENIES too — the hook never recreates it', () => {
		fs.rmSync(claimsDir, { recursive: true });
		expect(write(rw('A')).allowed).toBe(false);
		expect(fs.existsSync(claimsDir)).toBe(false);
	});
	it('a corrupt claim file DENIES — it could be the one that holds this checkout', () => {
		fs.writeFileSync(path.join(claimsDir, cc.claimFileName(cc.checkoutId(checkout))), '{ half a json');
		expect(write(rw('A')).allowed).toBe(false);
	});
	it('the SAME broken store ALLOWS a worktree session\'s write in its own worktree', () => {
		const wt = path.join(checkout, '.claude-worktrees', 'wt-main-1');
		fs.mkdirSync(wt, { recursive: true });
		expect(write({ id: 'W', name: 'W', mode: 'worktree', checkout: wt, claimsDir: broken() }, path.join(wt, 'a.ts')).allowed).toBe(true);
	});
});

// ---- 5. Worktree sessions beside a lease (Q9, lenient).

describe('worktree sessions and a shared-write lease in the same repo', () => {
	const wt = () => { const p = path.join(checkout, '.claude-worktrees', 'wt-main-1'); fs.mkdirSync(p, { recursive: true }); return p; };
	it('a worktree session writing its own (nested) worktree is not blocked by the primary\'s lease', () => {
		write(rw('A', 'fix-auth'));
		const p = wt();
		expect(write({ id: 'W', name: 'W', mode: 'worktree', checkout: p }, path.join(p, 'src', 'a.ts')).allowed).toBe(true);
	});
	it('but a worktree session writing INTO the held primary is refused, by name and path', () => {
		write(rw('A', 'fix-auth'));
		const r = write({ id: 'W', name: 'W', mode: 'worktree', checkout: wt() }, path.join(checkout, 'src', 'x.ts'));
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain('fix-auth');
	});
	it('a shared session may not write into a nested worktree — another session\'s', () => {
		const p = wt();
		expect(write(rw('A'), path.join(p, 'a.ts')).allowed).toBe(false);
	});
});

// ---- 6. The spawn path and the hook agree on one store.

describe('spawn-time lease (the app) and write-time gate (the hook) on one store', () => {
	const ctx = (o: Partial<IsolationContext> = {}): IsolationContext => ({ now: Date.now(), claims: claims.readClaims(claimsDir).map(claimOf), policy: 'cheapest-safe', rungCeiling: 'write', ...o });
	const intent = (taskClass: 'small-fix' | 'release' | 'feature') => resolveIntent({ taskClass }, { id: checkoutIdOf(checkout), path: checkout, primary: true }, 'write');
	it('A is spawned shared-write (the app takes the lease); A\'s hook allows; B\'s hook refuses', () => {
		const d = decideIsolation(intent('small-fix'), ctx());
		expect(d).toMatchObject({ ok: true, mode: 'shared-write', acquire: [`write:${cc.checkoutId(checkout)}`] });
		expect(claims.takeClaim(claimsDir, checkout, { sessionId: 'A', holder: 'fix-auth', mode: 'shared-write' }).ok).toBe(true);
		expect(write(rw('A', 'fix-auth')).allowed).toBe(true);
		expect(write(rw('B')).allowed).toBe(false);
	});
	it('with A holding it, B\'s small-fix spawn gets a worktree (FR-12) and B\'s release is refused naming A', () => {
		claims.takeClaim(claimsDir, checkout, { sessionId: 'A', holder: 'fix-auth' });
		expect(decideIsolation(intent('small-fix'), ctx())).toMatchObject({ ok: true, mode: 'worktree' });
		expect(decideIsolation(intent('release'), ctx())).toMatchObject({ ok: false, holder: 'fix-auth', path: path.resolve(checkout) });
	});
	it('B planned shared-write before A took it: B\'s take fails, and the re-decision is a worktree', () => {
		const plan = { intent: intent('small-fix'), ctx: ctx(), decision: decideIsolation(intent('small-fix'), ctx()) };
		expect(plan.decision).toMatchObject({ mode: 'shared-write' });
		claims.takeClaim(claimsDir, checkout, { sessionId: 'A', holder: 'fix-auth' }); // A won meanwhile
		const took = claims.takeClaim(claimsDir, checkout, { sessionId: 'B', holder: 'fix-typo' });
		expect(took.ok).toBe(false);
		expect(redecideAfterLostRace(plan, took.holder, checkout)).toMatchObject({ ok: true, mode: 'worktree' });
	});
	it('a worktree session\'s claim on its own path does not block shared-write in the primary (Q9)', () => {
		const p = path.join(checkout, '.claude-worktrees', 'wt-main-1');
		claims.takeClaim(claimsDir, p, { sessionId: 'W', holder: 'wt-main-1', mode: 'worktree' });
		expect(decideIsolation(intent('small-fix'), ctx())).toMatchObject({ ok: true, mode: 'shared-write' });
		expect(claims.takeClaim(claimsDir, checkout, { sessionId: 'A', holder: 'fix-auth' }).ok).toBe(true);
	});
});

// ---- 7. Q12: the automatic git locks are machine-wide too, and keyed on the REPOSITORY.
//
// Before: per workspace (two tabs could both hold push:<repo>), and named after the basename of the
// session's cwd — so every worktree session had its own push lock and none of them ever contended.

describe('Q12: push / worktree-add locks — two tabs, two worktrees, one repository', () => {
	const gitEnv = () => { const e: Record<string, string> = {}; for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('GIT_') && !k.toUpperCase().startsWith('COS_')) e[k] = v; return e; };
	const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
	let repo: string, wtA: string, wtB: string, other: string, wsA: string, wsB: string;
	beforeEach(() => {
		repo = path.join(root, 'shared-repo');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 't');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
		git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
		wtA = path.join(repo, '.claude-worktrees', 'wt-main-1');
		wtB = path.join(repo, '.claude-worktrees', 'wt-main-2');
		expect(git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-1', wtA, 'main').status).toBe(0);
		expect(git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-2', wtB, 'main').status).toBe(0);
		other = path.join(root, 'other-repo');
		fs.mkdirSync(other);
		git(other, 'init', '-q', '-b', 'main');
		wsA = path.join(root, '.coordination', 'tab-a'); wsB = path.join(root, '.coordination', 'tab-b');
		fs.mkdirSync(wsA, { recursive: true }); fs.mkdirSync(wsB, { recursive: true });
	});

	interface GitSession { ws: string; tile: string; sessionId?: string; name: string }
	const gitEnvOf = (s: GitSession): Record<string, string> => ({
		...gitEnv(), COS_COORD_DIR: s.ws, COS_CLAIMS_DIR: claimsDir, COS_TERMINAL_ID: s.tile, COS_TERMINAL_NAME: s.name, COS_COORD_WAIT_MS: '0',
		...(s.sessionId ? { COS_SESSION_ID: s.sessionId } : {}),
	});
	const bash = (command: string, cwd: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
	const run = (s: GitSession, command: string, cwd: string, release = false): Verdict => {
		const r = spawnSync('node', [HOOK, ...(release ? ['--release'] : [])], { input: bash(command, cwd), env: gitEnvOf(s), encoding: 'utf8' });
		return parse(r.stdout, r.status);
	};
	const runAsync = (s: GitSession, command: string, cwd: string): Promise<Verdict> => new Promise((resolve, reject) => {
		const c = spawn('node', [HOOK], { env: gitEnvOf(s) });
		let out = '';
		c.stdout.on('data', (d) => { out += d; });
		c.on('error', reject);
		c.on('close', (code) => { try { resolve(parse(out, code)); } catch (e) { reject(e); } });
		c.stdin.end(bash(command, cwd));
	});
	// Two sessions in two TABS (workspaces), with the SAME tile id — tile ids repeat across tabs.
	const sa = (): GitSession => ({ ws: wsA, tile: '1', sessionId: 'sess-A', name: 'tab-a/wt-main-1' });
	const sb = (): GitSession => ({ ws: wsB, tile: '1', sessionId: 'sess-B', name: 'tab-b/wt-main-2' });
	const gitLocks = () => claims.readGitLocks(claimsDir);

	it('two worktrees of one repo, in two tabs: the second push is refused, naming the first', () => {
		expect(run(sa(), 'git push', wtA).allowed).toBe(true);
		const b = run(sb(), 'git push', wtB);
		expect(b.allowed).toBe(false);
		expect(b.reason).toContain('push:shared-repo');
		expect(b.reason).toContain('tab-a/wt-main-1');
		expect(gitLocks()).toHaveLength(1);
		expect(gitLocks()[0]).toMatchObject({ resource: 'push:shared-repo', holderId: 'sess-A' });
	});
	it('the primary checkout and a worktree share the lock too', () => {
		expect(run(sa(), 'git push', repo).allowed).toBe(true);
		expect(run(sb(), 'git push origin wt/main-2', wtB).allowed).toBe(false);
	});
	it('the race: two tabs push one repo at the same instant — exactly one is allowed (10 rounds)', async () => {
		for (let round = 0; round < 10; round++) {
			for (const f of fs.readdirSync(claimsDir)) fs.rmSync(path.join(claimsDir, f));
			const [a, b] = await Promise.all([runAsync(sa(), 'git push', wtA), runAsync(sb(), 'git push', wtB)]);
			expect([a, b].filter((v) => v.allowed), JSON.stringify([a, b])).toHaveLength(1);
		}
	});
	it('after the holder\'s PostToolUse release, the other tab can push', () => {
		run(sa(), 'git push', wtA);
		run(sa(), 'git push', wtA, true);
		expect(gitLocks()).toHaveLength(0);
		expect(run(sb(), 'git push', wtB).allowed).toBe(true);
	});
	it('the same tile id in another tab is NOT the same holder: it cannot release, and it is refused', () => {
		run(sa(), 'git push', wtA);
		run(sb(), 'git push', wtB, true); // tile 1 in tab B "releases"
		expect(gitLocks()).toHaveLength(1);
		expect(run(sb(), 'git push', wtB).allowed).toBe(false);
	});
	it('without session ids the owner is workspace + tile, so equal tile ids in two tabs still differ', () => {
		const a = { ...sa(), sessionId: undefined }, b = { ...sb(), sessionId: undefined };
		expect(run(a, 'git push', wtA).allowed).toBe(true);
		expect(run(b, 'git push', wtB).allowed).toBe(false);
	});
	it('re-entrant: the holder pushing again (its PostToolUse never ran) is not refused by its own lock', () => {
		run(sa(), 'git push', wtA);
		expect(run(sa(), 'git push', wtA).allowed).toBe(true);
		expect(gitLocks()).toHaveLength(1);
	});
	it('a stale git lock is reclaimable', () => {
		run(sa(), 'git push', wtA);
		const f = claims.gitLockPath(claimsDir, 'push', gitLocks()[0].repo);
		fs.writeFileSync(f, JSON.stringify({ ...gitLocks()[0], ts: Date.now() - 11 * 60_000 }));
		expect(run(sb(), 'git push', wtB).allowed).toBe(true);
		expect(gitLocks()[0].holderId).toBe('sess-B');
	});
	it('push and worktree-add are separate locks; worktree-add is exclusive across tabs too', () => {
		expect(run(sa(), 'git push', wtA).allowed).toBe(true);
		expect(run(sb(), 'git worktree add ../x -b x main', wtB).allowed).toBe(true);
		expect(run(sa(), 'git worktree add ../y -b y main', wtA).allowed).toBe(false);
	});
	it('different repositories never contend', () => {
		expect(run(sa(), 'git push', wtA).allowed).toBe(true);
		expect(run(sb(), 'git push', other).allowed).toBe(true);
	});
	it('git -C <repo> locks the repo it names, not the cwd\'s', () => {
		expect(run(sa(), `git -C "${other}" push`, wtA).allowed).toBe(true);
		expect(run(sb(), 'git push', other).allowed).toBe(false);
		expect(run(sb(), 'git push', wtB).allowed).toBe(true); // shared-repo was never locked
	});
	it('each tab\'s board feed still gets its own START', () => {
		run(sa(), 'git push', wtA);
		expect(fs.readFileSync(path.join(wsA, 'board.md'), 'utf8')).toMatch(/push:shared-repo\tSTART/);
		expect(fs.existsSync(path.join(wsB, 'board.md'))).toBe(false);
	});
	it('cos-coord status in either tab lists the machine-wide git lock', () => {
		run(sa(), 'git push', wtA);
		const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
		const out = spawnSync('node', [CLI, 'status'], { env: gitEnvOf(sb()), encoding: 'utf8' }).stdout;
		expect(out).toMatch(/push:shared-repo — tab-a\/wt-main-1/);
	});
});
