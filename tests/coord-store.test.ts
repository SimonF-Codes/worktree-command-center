import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
const require = createRequire(import.meta.url);
const store = require('../pty-sidecar/coord-store.cjs');
const core = require('../pty-sidecar/coord-core.cjs');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-')); });

const holder = (id: number, name = `t${id}`) => ({ holderId: id, terminal: name });

describe('coord-store', () => {
  it('acquires a free resource, writes lock + START', () => {
    const r = store.acquire(dir, 'paper-trader:db', holder(1), { reason: 'replay', ttlMs: 1000, waitMs: 0, now: 1000 });
    expect(r.ok).toBe(true);
    const locks = store.readLocks(dir);
    expect(locks).toHaveLength(1);
    expect(locks[0].resource).toBe('paper-trader:db');
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8');
    expect(core.parseBoardLine(board.trim()).status).toBe('START');
  });

  it('a second holder waits then fails while the lock is fresh', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 60000, waitMs: 0, now: 1000 });
    const r = store.acquire(dir, 'r', holder(2), { ttlMs: 60000, waitMs: 30, pollMs: 10, now: 1000 });
    expect(r.ok).toBe(false);
    expect(r.holder.holderId).toBe(1);
  });

  it('steals a stale lock', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 1000, waitMs: 0, now: 1000 });
    const r = store.acquire(dir, 'r', holder(2), { ttlMs: 1000, waitMs: 0, now: 5000 });
    expect(r.ok).toBe(true);
    expect(store.readLocks(dir)[0].holderId).toBe(2);
  });

  it('release only by the holder; writes DONE', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 60000, waitMs: 0, now: 1000 });
    expect(store.release(dir, 'r', 2)).toBe(false);
    expect(store.release(dir, 'r', 1)).toBe(true);
    expect(store.readLocks(dir)).toHaveLength(0);
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8').trim().split('\n');
    expect(core.parseBoardLine(board[board.length - 1]).status).toBe('DONE');
  });

  it('a stale-break acting on an OLD read never unlinks a lock someone has since taken fresh', () => {
    // The race the guard closes: B read holder 1's stale lock; meanwhile A broke it and created a
    // fresh one. B's break must re-read under the guard and leave A's lock alone.
    store.acquire(dir, 'r', holder(1), { ttlMs: 1000, waitMs: 0, now: 1000 });
    const staleSeen = store.readHolder(dir, 'r');
    expect(store.acquire(dir, 'r', holder(2), { ttlMs: 60000, waitMs: 0, now: 5000 }).ok).toBe(true); // A took it
    // B now breaks with its stale view in hand: the re-read under the guard sees A's lock, not 1's.
    expect(store.breakStale(path.join(dir, 'locks', 'r.json'), staleSeen, 5000)).toBe(false);
    expect(store.readLocks(dir)[0].holderId).toBe(2);
    // ...and B's own acquire, reading afresh, is refused by A's live lock.
    const r = store.acquire(dir, 'r', holder(3), { ttlMs: 60000, waitMs: 0, now: 5000 });
    expect(r.ok).toBe(false);
    expect(r.holder.holderId).toBe(2);
  });

  it('the guard serialises: a held guard makes release wait, and a dead one is broken', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 60000, waitMs: 0, now: 1000 });
    const guard = path.join(dir, 'locks', 'r.json.guard');
    fs.writeFileSync(guard, 'dead');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(guard, old, old); // a process died inside the guard a minute ago
    expect(store.release(dir, 'r', 1)).toBe(true);
    expect(fs.existsSync(guard)).toBe(false);
    expect(store.readLocks(dir)).toHaveLength(0);
  });

  it('readLocks ignores guard and temp files', () => {
    store.acquire(dir, 'r', holder(1), { waitMs: 0, now: 1 });
    fs.writeFileSync(path.join(dir, 'locks', 'r.json.guard'), '1');
    fs.writeFileSync(path.join(dir, 'locks', 'r.json.123-abc.tmp'), '{');
    expect(store.readLocks(dir)).toHaveLength(1);
  });

  it('different resources never contend', () => {
    expect(store.acquire(dir, 'a', holder(1), { waitMs: 0, now: 1 }).ok).toBe(true);
    expect(store.acquire(dir, 'b', holder(2), { waitMs: 0, now: 1 }).ok).toBe(true);
  });

  it('tell writes one atomic JSON message into god-outbox', () => {
    const file = store.tell(dir, 'Improver 1', 'rebase please');
    expect(fs.existsSync(file)).toBe(true);
    const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(msg.target).toBe('Improver 1');
    expect(msg.message).toBe('rebase please');
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1); // no leftover .tmp
  });

  it('taskEvent appends a task:<tileId>:<taskId> board line, no lock', () => {
    store.taskEvent(dir, 't5', 5, 'abc123', 'START', 'audit auth');
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8').trim();
    const e = core.parseBoardLine(board);
    expect(e.resource).toBe('task:5:abc123');
    expect(e.status).toBe('START');
    expect(e.detail).toBe('audit auth');
    expect(fs.existsSync(path.join(dir, 'locks'))).toBe(false);
  });

  it('watch + spawn drop tagged outbox files', () => {
    store.watch(dir, 'Improver 1', 'run tests after');
    store.spawn(dir, 'app', 'main', 'do X');
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    const msgs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.kind === 'watch')).toMatchObject({ target: 'Improver 1', note: 'run tests after' });
    expect(msgs.find((m) => m.kind === 'spawn')).toMatchObject({ repo: 'app', base: 'main', task: 'do X' });
  });

  it('spawn records model/effort/name (null when omitted); rename drops a tagged file', () => {
    store.spawn(dir, 'app', '', 'do X');
    store.spawn(dir, 'app', 'main', 'do Y', 'opus', 'max', 'Linehaul');
    store.rename(dir, 'wt-1', 'Linehaul fix');
    const msgs = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.task === 'do X')).toMatchObject({ model: null, effort: null, name: null });
    expect(msgs.find((m) => m.task === 'do Y')).toMatchObject({ model: 'opus', effort: 'max', name: 'Linehaul' });
    expect(msgs.find((m) => m.kind === 'rename')).toMatchObject({ target: 'wt-1', name: 'Linehaul fix' });
  });
});
