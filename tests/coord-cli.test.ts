import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')); });

function run(args: string[], id = '1', name = 'termA') {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      env: { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: id, COS_TERMINAL_NAME: name, COS_COORD_WAIT_MS: '0' },
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
    execFileSync('node', [CLI, 'tell', 'A', 'hello'], {
      env: { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god' }, encoding: 'utf8',
    });
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const msg = JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', files[0]), 'utf8'));
    expect(msg).toMatchObject({ target: 'A', message: 'hello' });
  });
  it('watch/spawn are god-only and drop tagged files', () => {
    // No role → refused (exit 2), nothing written
    const denied = run(['watch', 'A', '--note', 'x'], '1', 'x');
    expect(denied.code).toBe(2);
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
    // As god → files appear
    const god = { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Able', COS_ROLE: 'god' };
    execFileSync('node', [CLI, 'watch', 'A', '--note', 'run tests'], { env: god, encoding: 'utf8' });
    execFileSync('node', [CLI, 'spawn', 'app', '--base', 'main', '--task', 'do X'], { env: god, encoding: 'utf8' });
    execFileSync('node', [CLI, 'spawn', 'app', '--base', 'main', '--task', 'do Y', '--model', 'opus', '--effort', 'max', '--name', 'Linehaul'], { env: god, encoding: 'utf8' });
    execFileSync('node', [CLI, 'rename', 'wt-1', '--to', 'Linehaul fix'], { env: god, encoding: 'utf8' });
    const msgs = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.kind === 'watch')).toMatchObject({ target: 'A', note: 'run tests' });
    expect(msgs.find((m) => m.kind === 'spawn')).toMatchObject({ repo: 'app', base: 'main', task: 'do X' });
    expect(msgs.find((m) => m.kind === 'spawn' && m.task === 'do X')).toMatchObject({ model: null, effort: null, name: null });
    expect(msgs.find((m) => m.kind === 'spawn' && m.task === 'do Y')).toMatchObject({ model: 'opus', effort: 'max', name: 'Linehaul' });
    expect(msgs.find((m) => m.kind === 'rename')).toMatchObject({ target: 'wt-1', name: 'Linehaul fix' });
  });
});
