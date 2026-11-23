import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeSessionEnv } from '../src/terminals/session-env';
import { runSpawn, accepted } from './spawn-harness';
import { makeTempDir } from './temp-dir';

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
// The outer shell's COS_* must not leak in: run from a worker the app spawned before the
// session-env fix, COS_ROLE=god was inherited and the "worker is refused" cases ran as god and failed.
const BASE_ENV = sanitizeSessionEnv(process.env);
let dir: string;
beforeEach(() => { dir = makeTempDir('cli-'); });

/** Poll `cond` until it's true or `timeoutMs` elapses (throws). Used to wait for `tell`'s
 *  outbox drop from a concurrently-running child before this test plays the app's part. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The id `tell` uses to name its receipt file: the outbox request's own filename, minus '.json'. */
function outboxIdFor(coordDir: string): string {
  const files = fs.readdirSync(path.join(coordDir, 'god-outbox')).filter((f) => f.endsWith('.json'));
  if (files.length !== 1) throw new Error(`expected exactly one dropped outbox file, found ${files.length}`);
  return files[0].replace(/\.json$/, '');
}

function writeTellReceipt(coordDir: string, id: string, receipt: { ok: boolean; reason?: string }): void {
  const receiptsDir = path.join(coordDir, 'god-outbox', '.receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, `${id}.json`), JSON.stringify(receipt), 'utf8');
}

function run(args: string[], id = '1', name = 'termA') {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      env: { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: id, COS_TERMINAL_NAME: name, COS_COORD_WAIT_MS: '0' },
      encoding: 'utf8',
    });
    return { code: 0, out, err: '' };
  } catch (e: unknown) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout, err: err.stderr };
  }
}

describe('cos-coord CLI', () => {
  it('acquire then release round-trips (exit 0)', () => {
    expect(run(['acquire', 'paper-trader:db', '--reason', 'replay']).code).toBe(0);
    expect(run(['release', 'paper-trader:db']).code).toBe(0);
  });
  it('a held resource fails acquire with exit 1', () => {
    run(['acquire', 'r'], '1', 'A');
    expect(run(['acquire', 'r'], '2', 'B').code).toBe(1);
  });
  it('status lists the active lock', () => {
    run(['acquire', 'r', '--reason', 'busy'], '1', 'A');
    const s = run(['status'], '2', 'B');
    expect(s.code).toBe(0);
    expect(s.out).toContain('r');
    expect(s.out).toContain('busy');
  });
  it('note appends to the board', () => {
    expect(run(['note', 'hello world']).code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'board.md'), 'utf8')).toContain('hello world');
  });
  it('chat appends a parseable line to chat.md', () => {
    expect(run(['chat', 'hello team'], '1', 'A').code).toBe(0);
    const txt = fs.readFileSync(path.join(dir, 'chat.md'), 'utf8').trim();
    const parts = txt.split('\t');
    expect(parts[1]).toBe('A');
    expect(parts[2]).toBe('hello team');
  });
  it('tell without COS_ROLE=god is refused: exit 2, no file, stderr explains why', () => {
    const r = run(['tell', 'A', 'hello'], '1', 'x');
    expect(r.code).toBe(2);
    expect(r.err).toContain('COS_ROLE=god');
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
  });
  it('tell from GOD drops a message file', () => {
    // Nothing plays the app's part here, so with a short wait `tell` gives up honestly (exit 2)
    // instead of the old exit-0-on-drop behavior — dropping the file was never proof of delivery.
    const env = { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god', COS_COORD_TELL_WAIT_MS: '80' };
    try {
      execFileSync('node', [CLI, 'tell', 'A', 'hello'], { env, encoding: 'utf8' });
      throw new Error('expected tell to exit non-zero when nothing confirms delivery');
    } catch (e: unknown) {
      const err = e as { status: number; stderr: string };
      expect(err.status).toBe(2);
      expect(err.stderr).toContain('NOT delivered');
    }
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const msg = JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', files[0]), 'utf8'));
    expect(msg).toMatchObject({ target: 'A', message: 'hello' });
  });

  it('tell reports success (exit 0) once the app confirms delivery via a receipt', async () => {
    const env = { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god', COS_COORD_TELL_WAIT_MS: '3000' };
    const child = execFile('node', [CLI, 'tell', 'A', 'hello'], { env, encoding: 'utf8' });
    await waitFor(() => fs.existsSync(path.join(dir, 'god-outbox')) && fs.readdirSync(path.join(dir, 'god-outbox')).some((f) => f.endsWith('.json')));
    writeTellReceipt(dir, outboxIdFor(dir), { ok: true });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      let out = '';
      child.stdout?.on('data', (d) => { out += d; });
      child.on('exit', (code) => resolve({ code, stdout: out }));
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('delivered');
  });

  it('tell reports failure (exit 2) with the app\'s own reason when the receipt says it was NOT delivered', async () => {
    const env = { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god', COS_COORD_TELL_WAIT_MS: '3000' };
    const child = execFile('node', [CLI, 'tell', 'A', 'hello'], { env, encoding: 'utf8' });
    await waitFor(() => fs.existsSync(path.join(dir, 'god-outbox')) && fs.readdirSync(path.join(dir, 'god-outbox')).some((f) => f.endsWith('.json')));
    writeTellReceipt(dir, outboxIdFor(dir), { ok: false, reason: 'not accepted within 40s — mid-/compact' });
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let err = '';
      child.stderr?.on('data', (d) => { err += d; });
      child.on('exit', (code) => resolve({ code, stderr: err }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mid-/compact');
  });

  it('watch/spawn are god-only and drop tagged files', async () => {
    // No role → refused (exit 2), nothing written
    const denied = run(['watch', 'A', '--note', 'x'], '1', 'x');
    expect(denied.code).toBe(2);
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
    expect(run(['spawn', 'app', '--task', 'x'], '1', 'x').code).toBe(2);
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
    // As god → files appear
    const god = { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Able', COS_ROLE: 'god', COS_COORD_SPAWN_WAIT_MS: '10000' };
    execFileSync('node', [CLI, 'watch', 'A', '--note', 'run tests'], { env: god, encoding: 'utf8' });
    execFileSync('node', [CLI, 'rename', 'wt-1', '--to', 'Linehaul fix'], { env: god, encoding: 'utf8' });
    const msgs = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.kind === 'watch')).toMatchObject({ target: 'A', note: 'run tests' });
    expect(msgs.find((m) => m.kind === 'rename')).toMatchObject({ target: 'wt-1', name: 'Linehaul fix' });
    // spawn blocks on the app's receipt, so these run against a fake app (spawn-harness).
    for (const f of fs.readdirSync(path.join(dir, 'god-outbox')).filter((x) => x.endsWith('.json'))) fs.unlinkSync(path.join(dir, 'god-outbox', f));
    const x = await runSpawn(dir, ['app', '--base', 'main', '--task', 'do X'], god, accepted());
    expect(x.request).toMatchObject({ kind: 'spawn', repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null });
    const y = await runSpawn(dir, ['app', '--base', 'main', '--task', 'do Y', '--model', 'opus', '--effort', 'max', '--name', 'Linehaul'], god, accepted());
    expect(y.request).toMatchObject({ kind: 'spawn', task: 'do Y', model: 'opus', effort: 'max', name: 'Linehaul' });
  });

  describe('spawn receipts', () => {
    const godEnv = (waitMs: string) => ({ ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Kane', COS_ROLE: 'god', COS_SESSION_ID: 'kane-1', COS_COORD_SPAWN_WAIT_MS: waitMs });

    it('a receipt is written and the CLI reports success with the terminal, its branch and the new identity', async () => {
      const r = await runSpawn(dir, ['app', '--task', 'do X'], godEnv('10000'), accepted('sess-abc', 'wt-main-7', 'wt/main-7'));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"wt-main-7"');
      expect(r.stdout).toContain('wt/main-7');
      expect(r.stdout).toContain('sess-abc');
      expect(r.request).toMatchObject({ kind: 'spawn', from: 'kane-1' });
      expect(fs.readdirSync(path.join(dir, 'god-outbox', '.receipts'))).toEqual([]); // the CLI cleans its receipt up
    });

    it('a request that is never accepted exits non-zero with the reason, and is withdrawn so it cannot run late', async () => {
      const r = await runSpawn(dir, ['app', '--task', 'do X'], godEnv('600')); // no app is running
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('WITHDRAWN');
      expect(r.stderr).toContain('nothing was spawned');
      expect(fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))).toEqual([]);
    });

    it('the app refusing exits 2 with the app\'s own reason', async () => {
      const r = await runSpawn(dir, ['ghost', '--task', 'do X'], godEnv('10000'), () => ({ ok: false, reason: 'unknown repo "ghost"' }));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('did NOT happen');
      expect(r.stderr).toContain('unknown repo "ghost"');
    });

    it('the app claiming it but never answering exits 3: it may still appear', async () => {
      const r = await runSpawn(dir, ['app', '--task', 'do X'], godEnv('600'), () => null);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('NOT confirmed');
    });
  });
  describe('close', () => {
    const godEnv = (waitMs: string) => ({ ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Kane', COS_ROLE: 'god', COS_COORD_CLOSE_WAIT_MS: waitMs });
    /** Start `close`, play the app's part by filing `receipt` once the request lands, and collect the exit. */
    async function closeWith(receipt: Record<string, unknown>) {
      const child = execFile('node', [CLI, 'close', 'wt-1'], { env: godEnv('3000'), encoding: 'utf8' });
      let out = '', err = '';
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      await waitFor(() => fs.existsSync(path.join(dir, 'god-outbox')) && fs.readdirSync(path.join(dir, 'god-outbox')).some((f) => f.endsWith('.json')));
      const id = outboxIdFor(dir);
      const msg = JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', `${id}.json`), 'utf8'));
      writeTellReceipt(dir, id, receipt as { ok: boolean; reason?: string });
      return { code: await exited, out, err, msg };
    }

    it('is refused without COS_ROLE=god: exit 2, nothing dropped', () => {
      const r = run(['close', 'wt-1'], '1', 'wt-2');
      expect(r.code).toBe(2);
      expect(r.err).toContain('close requires COS_ROLE=god');
      expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
    });
    it('drops a close request and reports the app\'s result, mid-turn included (exit 0)', async () => {
      const r = await closeWith({ ok: true, message: 'closed wt-1 (was mid-turn) — worktree and branch kept, reopen it from the Coordination panel' });
      expect(r.msg).toMatchObject({ kind: 'close', target: 'wt-1' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('closed wt-1 (was mid-turn)');
    });
    it('reports a refusal as a failure with the app\'s reason (exit 2)', async () => {
      const r = await closeWith({ ok: false, reason: '"Kane" is an overseer console, not a worker session — refused' });
      expect(r.code).toBe(2);
      expect(r.err).toContain('did NOT happen');
      expect(r.err).toContain('overseer console');
    });
    it('never reads silence as success: no receipt → exit 2, "not confirmed"', () => {
      try {
        execFileSync('node', [CLI, 'close', 'wt-1'], { env: godEnv('80'), encoding: 'utf8' });
        throw new Error('expected close to exit non-zero when nothing confirms it');
      } catch (e: unknown) {
        const err = e as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain('was NOT confirmed');
        expect(err.stderr).toContain('may still happen');
      }
    });
  });

  it('as GOD, a required arg left empty is refused (exit 2) instead of silently dropping nothing', () => {
    const god = { ...BASE_ENV, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god' };
    const cases: Array<[string[], string]> = [
      [['tell', 'A'], 'tell requires'],
      [['watch', 'A'], 'watch requires'],
      [['spawn', 'app', '--base', 'main'], 'spawn requires'], // no --task
      [['rename', 'A'], 'rename requires'], // no --to
      [['close'], 'close requires'], // no target
      [['close', '  '], 'close requires'], // blank target
    ];
    for (const [args, expectedErr] of cases) {
      try {
        execFileSync('node', [CLI, ...args], { env: god, encoding: 'utf8' });
        throw new Error(`expected ${args.join(' ')} to exit non-zero`);
      } catch (e: unknown) {
        const err = e as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain(expectedErr);
      }
    }
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
  });
});
