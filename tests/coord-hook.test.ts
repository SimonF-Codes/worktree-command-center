import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTempDir } from './temp-dir';

const HOOK = path.join(__dirname, '..', 'pty-sidecar', 'coord-hook.cjs');
let dir: string;
let claimsDir: string;
beforeEach(() => {
  dir = makeTempDir('hook-');
  claimsDir = path.join(dir, '_claims');
  fs.mkdirSync(claimsDir);
});

// The runner's own COS_* never leak in: run from a session the app opened, an inherited
// COS_SESSION_ID would make every "different" holder below the same one.
const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('COS_')) env[k] = v;
  return env;
};
function run(input: object, args: string[], id: string) {
  const out = execFileSync('node', [HOOK, ...args], {
    input: JSON.stringify(input),
    env: { ...cleanEnv(), COS_COORD_DIR: dir, COS_CLAIMS_DIR: claimsDir, COS_TERMINAL_ID: id, COS_TERMINAL_NAME: 't' + id, COS_COORD_WAIT_MS: '0' },
    encoding: 'utf8',
  });
  return out;
}
// '/repo/foo' is not a git repo, so the lock is named the pre-Q12 way, by the folder name.
const push = { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/repo/foo' };
const pushLock = () => path.join(claimsDir, cc.gitLockFileName('push', 'name:foo'));
const cc = require('../pty-sidecar/claims-core.cjs');

describe('coord-hook', () => {
  it('allows (empty output) and locks on a free push — in the machine-wide _claims/, not locks/', () => {
    const out = run(push, [], '1');
    expect(out.trim()).toBe('');
    expect(fs.existsSync(pushLock())).toBe(true);
    expect(JSON.parse(fs.readFileSync(pushLock(), 'utf8'))).toMatchObject({ resource: 'push:foo', holder: 't1' });
    expect(fs.existsSync(path.join(dir, 'locks'))).toBe(false);
  });
  it('writes START to the workspace board as before', () => {
    run(push, [], '1');
    expect(fs.readFileSync(path.join(dir, 'board.md'), 'utf8')).toMatch(/push:foo\tSTART/);
  });
  it('denies a second push while held', () => {
    run(push, [], '1');
    const out = run(push, [], '2');
    expect(out).toContain('"permissionDecision":"deny"');
  });
  it('release removes the lock; a non-holder\'s release does not', () => {
    run(push, [], '1');
    run(push, ['--release'], '2');
    expect(fs.existsSync(pushLock())).toBe(true);
    run(push, ['--release'], '1');
    expect(fs.existsSync(pushLock())).toBe(false);
  });
  it('ignores non-git commands (empty output, no lock)', () => {
    const out = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/repo/foo' }, [], '1');
    expect(out.trim()).toBe('');
    expect(fs.readdirSync(claimsDir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'locks'))).toBe(false);
  });
  it('a command carrying a placeholder target takes no lock and is allowed (doc text, not a git op)', () => {
    // What a session WRITING about worktrees sends through Bash: the hook sees `git … worktree add`
    // in the text. Before this, it locked "worktree:<repo>" — a lock that outlived the session.
    const doc = { tool_name: 'Bash', tool_input: { command: "cat > notes.md <<'EOF'\nRun: git -C <repo> worktree add -b <branch> <path> <base>\nEOF" }, cwd: '/repo/foo' };
    expect(run(doc, [], '1').trim()).toBe('');
    expect(run(doc, [], '2').trim()).toBe(''); // and again from another session: nothing is held
    expect(run(doc, ['--release'], '1').trim()).toBe('');
    expect(fs.readdirSync(claimsDir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'board.md'))).toBe(false);
  });
  it('a normal `git worktree add` on a real path still locks exactly as before', () => {
    const target = makeTempDir('RealRepo-'); // a real folder, not a git repo
    const add = { tool_name: 'Bash', tool_input: { command: `git -C "${target}" worktree add ../x` }, cwd: '/repo/foo' };
    expect(run(add, [], '1').trim()).toBe('');
    const lock = path.join(claimsDir, cc.gitLockFileName('worktree', `name:${path.basename(target).toLowerCase()}`));
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toMatchObject({ resource: `worktree:${path.basename(target)}`, holder: 't1' });
    expect(run(add, [], '2')).toContain('"permissionDecision":"deny"');
    run(add, ['--release'], '1');
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('stays fail-open: a missing machine-wide store allows the push (and is not created)', () => {
    fs.rmSync(claimsDir, { recursive: true });
    expect(run(push, [], '1').trim()).toBe('');
    expect(fs.existsSync(claimsDir)).toBe(false);
  });
});

describe('coord-hook --task', () => {
  it('logs a START board event on PreToolUse, keyed by tileId + tool_use_id', () => {
    const out = run({ tool_name: 'Task', tool_input: { description: 'audit auth' }, tool_use_id: 'abc123' }, ['--task'], '5');
    expect(out.trim()).toBe('');
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8').trim();
    expect(board).toContain('task:5:abc123');
    expect(board).toContain('START');
    expect(board).toContain('audit auth');
  });
  it('logs a matching DONE board event on PostToolUse (--task --release)', () => {
    run({ tool_name: 'Task', tool_input: { description: 'audit auth' }, tool_use_id: 'abc123' }, ['--task'], '5');
    run({ tool_name: 'Task', tool_use_id: 'abc123' }, ['--task', '--release'], '5');
    const lines = fs.readFileSync(path.join(dir, 'board.md'), 'utf8').trim().split('\n');
    expect(lines[lines.length - 1]).toContain('task:5:abc123');
    expect(lines[lines.length - 1]).toContain('DONE');
  });
  it('does not create a lock (tasks never contend)', () => {
    run({ tool_name: 'Task', tool_input: { description: 'audit auth' }, tool_use_id: 'abc123' }, ['--task'], '5');
    expect(fs.existsSync(path.join(dir, 'locks'))).toBe(false);
  });
});

// ---- The write gate (--write, V2 step 9): its failure policy, in BOTH directions. The contention
// behaviour — two sessions, one checkout — is the collision suite (claims-collision.test.ts).
const hookModule = require('../pty-sidecar/coord-hook.cjs');

function gate(input: object | string, extraEnv: Record<string, string | undefined>, args: string[] = ['--write']) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('COS_')) env[k] = v;
  for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) env[k] = v;
  const r = require('node:child_process').spawnSync('node', [HOOK, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8',
  });
  return { code: r.status as number, out: String(r.stdout), denied: String(r.stdout).includes('"permissionDecision":"deny"') };
}

describe('coord-hook --write: failurePolicyFor is the one place, and a function of the mode', () => {
  it('open for no mode and for worktree; closed for every shared mode and for anything unrecognised', () => {
    expect(hookModule.failurePolicyFor(undefined)).toBe('open');
    expect(hookModule.failurePolicyFor('')).toBe('open');
    expect(hookModule.failurePolicyFor('worktree')).toBe('open');
    for (const m of ['shared-readonly', 'shared-write', 'scratch', 'Shared-Write', 'something-new']) expect(hookModule.failurePolicyFor(m)).toBe('closed');
  });
});

describe('coord-hook --write: broken store / environment, both directions', () => {
  let checkout: string;
  beforeEach(() => { checkout = makeTempDir('gate-co-'); });
  const write = () => ({ tool_name: 'Write', tool_input: { file_path: path.join(checkout, 'a.txt'), content: 'x' }, cwd: checkout });
  const brokenStore = () => { const f = path.join(dir, 'not-a-dir'); fs.writeFileSync(f, 'x'); return f; }; // readdir → ENOTDIR

  for (const mode of ['shared-readonly', 'shared-write', 'scratch']) {
    it(`${mode}: an unreadable store DENIES (fail closed), and says so`, () => {
      const r = gate(write(), { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_CLAIMS_DIR: brokenStore(), COS_SESSION_ID: 's1', COS_ISOLATION_POLICY: 'cheapest-safe', COS_RUNG: 'write', COS_TASK_CLASS: 'small-fix' });
      expect(r.code).toBe(0);
      expect(r.denied).toBe(true);
      expect(r.out).toMatch(/could not be read|DENIED/);
    });
    it(`${mode}: a missing store directory DENIES`, () => {
      const r = gate(write(), { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_CLAIMS_DIR: path.join(dir, 'never-made'), COS_SESSION_ID: 's1', COS_ISOLATION_POLICY: 'cheapest-safe', COS_RUNG: 'write', COS_TASK_CLASS: 'small-fix' });
      expect(r.denied).toBe(true);
      expect(fs.existsSync(path.join(dir, 'never-made'))).toBe(false); // and the hook never makes it
    });
    it(`${mode}: no store configured at all DENIES`, () => {
      expect(gate(write(), { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_SESSION_ID: 's1' }).denied).toBe(true);
    });
    it(`${mode}: unparseable hook input DENIES`, () => {
      expect(gate('{not json', { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_CLAIMS_DIR: dir, COS_SESSION_ID: 's1' }).denied).toBe(true);
    });
  }
  it('an unrecognised mode fails closed too', () => {
    expect(gate(write(), { COS_ISOLATION: 'something-new', COS_CHECKOUT: checkout, COS_CLAIMS_DIR: brokenStore(), COS_SESSION_ID: 's1' }).denied).toBe(true);
  });

  for (const mode of ['worktree', undefined]) {
    const label = mode ?? 'no mode';
    it(`${label}: an unreadable store ALLOWS (fail open)`, () => {
      const r = gate(write(), { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_CLAIMS_DIR: brokenStore(), COS_SESSION_ID: 's1' });
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe('');
    });
    it(`${label}: no store configured ALLOWS`, () => {
      expect(gate(write(), { COS_ISOLATION: mode, COS_SESSION_ID: 's1' }).out.trim()).toBe('');
    });
    it(`${label}: unparseable hook input ALLOWS`, () => {
      expect(gate('{not json', { COS_ISOLATION: mode, COS_CLAIMS_DIR: dir }).out.trim()).toBe('');
    });
    it(`${label}: an empty, healthy store ALLOWS`, () => {
      expect(gate(write(), { COS_ISOLATION: mode, COS_CHECKOUT: checkout, COS_CLAIMS_DIR: dir, COS_SESSION_ID: 's1' }).out.trim()).toBe('');
    });
  }

  it('PostToolUse (--renew) never denies, even closed with a broken store — the write already happened', () => {
    const r = gate(write(), { COS_ISOLATION: 'shared-write', COS_CHECKOUT: checkout, COS_CLAIMS_DIR: brokenStore(), COS_SESSION_ID: 's1' }, ['--write', '--renew']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('');
  });
  it('the Bash mode is still fail-open with COS_COORD_DIR unset', () => {
    expect(gate(push, {}, []).out.trim()).toBe('');
  });
});
