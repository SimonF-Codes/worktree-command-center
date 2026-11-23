// The IO half of isolation A: the intent travels from `cos-coord spawn` to the app intact, the rung
// ceiling comes from the role file's `authority:`, and the decision those produce is the one the
// spawn path executes. No window and no app: the grid's own planIsolation is three calls, and this
// replays them on the same inputs.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOutboxMessage, spawnExtrasOf, spawnReceipt } from '../src/terminals/god';
import { sanitizeSessionEnv } from '../src/terminals/session-env';
import { loadRoleAuthority } from '../src/terminals/role-loader';
import { sessionRoleSlug } from '../src/terminals/role-library';
import { decideIsolation, resolveIntent, rungCeilingOf, isolationInstruction, type IsolationPolicy } from '../src/core/isolation';
import { runSpawn, accepted } from './spawn-harness';
import { makeTempDir } from './temp-dir';
const core = require('../pty-sidecar/coord-core.cjs');

const dirs: string[] = [];
const tmp = (p: string) => { const d = makeTempDir(p); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

async function spawnViaCli(args: string[]) {
	const dir = tmp('iso-spawn-');
	const env = { ...sanitizeSessionEnv(process.env), COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Kane', COS_ROLE: 'god', COS_COORD_SPAWN_WAIT_MS: '10000' };
	const run = await runSpawn(dir, args, env, accepted());
	expect(run.code).toBe(0);
	const raw = run.request!;
	const msg = parseOutboxMessage(JSON.stringify(raw));
	if (!msg || msg.kind !== 'spawn') throw new Error(`not a spawn: ${JSON.stringify(raw)}`);
	return { raw, msg };
}

function library(roles: Record<string, string>): string {
	const d = tmp('iso-roles-');
	for (const [slug, authority] of Object.entries(roles)) {
		fs.writeFileSync(path.join(d, `${slug}.md`), `---\nrole: ${slug}\nstatus: active\nauthority: ${authority}   # the rung\n---\n\nBody of ${slug}.\n`, 'utf8');
	}
	return d;
}

/** The grid's planIsolation, step for step (terminals-grid.ts). */
function plan(extras: ReturnType<typeof spawnExtrasOf>, libraryPath: string | undefined, policy: IsolationPolicy) {
	const role = sessionRoleSlug(extras.roleSlug, false);
	const rungCeiling = rungCeilingOf(loadRoleAuthority(libraryPath, role));
	const checkout = { id: 'c:/dev/app', path: 'C:/dev/app', primary: true };
	const intent = resolveIntent({ taskClass: extras.taskClass, writes: extras.writes, requested: extras.isolation }, checkout, rungCeiling);
	return decideIsolation(intent, { now: 0, claims: [], policy, rungCeiling, role });
}

describe('spawn --class / --writes / --isolation reach the app', () => {
	it('are carried on the request and into the spawn extras', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'look at X', '--class', 'investigate', '--writes', 'none', '--isolation', 'shared-readonly']);
		expect(raw).toMatchObject({ taskClass: 'investigate', writes: 'none', isolation: 'shared-readonly' });
		expect(spawnExtrasOf(msg)).toMatchObject({ taskClass: 'investigate', writes: 'none', isolation: 'shared-readonly' });
	});
	it('omitted, they are null on the request and absent from the extras — a worktree, as before', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'build X']);
		expect(raw).toMatchObject({ taskClass: null, writes: null, isolation: null });
		const extras = spawnExtrasOf(msg);
		expect(extras).not.toHaveProperty('taskClass');
		for (const policy of ['worktree-always', 'cheap-readonly'] as const) expect(plan(extras, undefined, policy)).toMatchObject({ ok: true, mode: 'worktree' });
	});
	it('an older drop with none of the fields parses exactly as before', () => {
		const msg = parseOutboxMessage(JSON.stringify({ kind: 'spawn', repo: 'app', task: 't' }));
		expect(msg).toEqual({ kind: 'spawn', repo: 'app', base: null, task: 't', model: null, effort: null, name: null, workstream: null, role: null, from: null });
	});
});

describe('the decision the spawn path executes', () => {
	it('worktree-always (default): an investigate spawn still gets a worktree', async () => {
		const { msg } = await spawnViaCli(['app', '--task', 'look', '--class', 'investigate']);
		expect(plan(spawnExtrasOf(msg), undefined, 'worktree-always')).toMatchObject({ ok: true, mode: 'worktree' });
	});
	it('cheap-readonly: investigate → shared-readonly, doc → scratch', async () => {
		const a = await spawnViaCli(['app', '--task', 'look', '--class', 'investigate']);
		expect(plan(spawnExtrasOf(a.msg), undefined, 'cheap-readonly')).toMatchObject({ ok: true, mode: 'shared-readonly' });
		const b = await spawnViaCli(['app', '--task', 'write it up', '--class', 'doc']);
		expect(plan(spawnExtrasOf(b.msg), undefined, 'cheap-readonly')).toMatchObject({ ok: true, mode: 'scratch' });
	});
	it('a proposer role gets shared-readonly by default and is refused a declared repo write, naming role and path', async () => {
		const lib = library({ researcher: 'proposer', 'worker-terminal': 'operator' });
		const a = await spawnViaCli(['app', '--task', 'research', '--role', 'researcher']);
		expect(plan(spawnExtrasOf(a.msg), lib, 'cheap-readonly')).toMatchObject({ ok: true, mode: 'shared-readonly' });
		const b = await spawnViaCli(['app', '--task', 'research', '--role', 'researcher', '--class', 'small-fix', '--writes', 'repo']);
		expect(plan(spawnExtrasOf(b.msg), lib, 'cheap-readonly')).toMatchObject({ ok: false, holder: 'researcher', path: 'C:/dev/app' });
	});
	it('--isolation shared-write is refused under every policy but cheapest-safe, naming a holder and a path', async () => {
		const { msg } = await spawnViaCli(['app', '--task', 'fix', '--isolation', 'shared-write']);
		for (const policy of ['worktree-always', 'cheap-readonly'] as const) {
			const d = plan(spawnExtrasOf(msg), undefined, policy);
			expect(d.ok).toBe(false);
			if (!d.ok) { expect(d.holder).toContain(policy); expect(d.path).toBe('C:/dev/app'); }
		}
		expect(plan(spawnExtrasOf(msg), undefined, 'cheapest-safe')).toMatchObject({ ok: true, mode: 'shared-write', acquire: ['write:c:/dev/app'] });
	});
	it('cheapest-safe: --class small-fix gets shared-write, a feature still gets a worktree', async () => {
		const a = await spawnViaCli(['app', '--task', 'one-line fix', '--class', 'small-fix']);
		expect(plan(spawnExtrasOf(a.msg), undefined, 'cheapest-safe')).toMatchObject({ ok: true, mode: 'shared-write' });
		const b = await spawnViaCli(['app', '--task', 'build X']);
		expect(plan(spawnExtrasOf(b.msg), undefined, 'cheapest-safe')).toMatchObject({ ok: true, mode: 'worktree' });
	});
});

describe('loadRoleAuthority — the rung ceiling source', () => {
	it('reads authority: from the role file, inline comment stripped', () => {
		const lib = library({ researcher: 'proposer', auditor: 'observer', 'worker-terminal': 'operator' });
		expect(loadRoleAuthority(lib, 'researcher')).toBe('proposer');
		expect(rungCeilingOf(loadRoleAuthority(lib, 'auditor'))).toBe('readonly');
		expect(rungCeilingOf(loadRoleAuthority(lib, 'worker-terminal'))).toBe('write');
	});
	it('undefined (write-capable) when the session runs on a compiled default', () => {
		const lib = library({ researcher: 'proposer' });
		fs.writeFileSync(path.join(lib, 'draft.md'), '---\nrole: draft\nstatus: draft\nauthority: proposer\n---\n\nx\n');
		expect(loadRoleAuthority(undefined, 'researcher')).toBeUndefined();
		expect(loadRoleAuthority(path.join(lib, 'missing'), 'researcher')).toBeUndefined();
		expect(loadRoleAuthority(lib, 'no-such-role')).toBeUndefined();
		expect(loadRoleAuthority(lib, 'draft')).toBeUndefined(); // inactive → runs as the compiled default
	});
});

describe('the session is told its mode, and the receipt says it', () => {
	it('ro and scratch carry an instruction; worktree modes carry none', () => {
		expect(isolationInstruction('shared-readonly')).toMatch(/Read only/);
		expect(isolationInstruction('scratch')).toMatch(/Do not write inside any repository/);
		expect(isolationInstruction('worktree')).toBeUndefined();
		expect(isolationInstruction(undefined)).toBeUndefined();
	});
	it('cos-coord names a ro/scr session by its mode, not as a folder', () => {
		const ro = spawnReceipt({ name: 'app', branch: '', sessionId: 's-1', mode: 'shared-readonly' }, '');
		expect(core.spawnOutcome(ro, { repo: 'app' }).out).toBe('coord: spawned "app" (shared-readonly — no branch) — session s-1');
		const folder = spawnReceipt({ name: 'notes', branch: '', sessionId: 's-2' }, '');
		expect(core.spawnOutcome(folder, { repo: 'notes' }).out).toContain('(folder — no branch)');
		const wt = spawnReceipt({ name: 'wt-main-7', branch: 'wt/main-7', sessionId: 's-3', mode: 'worktree' }, '');
		expect(core.spawnOutcome(wt, { repo: 'app' }).out).toContain('on wt/main-7');
	});
});
