'use strict';
// IO layer: atomic per-resource locks + append-only board (and the primitive claims-store.cjs
// builds the machine-wide write claims on: acquireAt / withGuard). Fails by throwing;
// callers (cli/hook) decide fail-open. Uses coord-core for slug/status/format.
const fs = require('fs');
const path = require('path');
const core = require('./coord-core.cjs');

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function locksDir(dir) { return path.join(dir, 'locks'); }
function lockPath(dir, resource) { return path.join(locksDir(dir), core.slug(resource) + '.json'); }

function ensureDir(dir) { fs.mkdirSync(locksDir(dir), { recursive: true }); }

function appendBoard(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'board.md'), core.formatBoardLine(event), 'utf8');
}

// Read one lock/claim file. A `wx` create is not atomic for READERS — the name appears empty and
// the payload follows — so an unparseable file is re-read briefly before it counts as unreadable.
// { state: 'missing' } | { state: 'unreadable' } | { state: 'ok', holder }.
function readFileState(file, retries = 10) {
  for (let i = 0; ; i++) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { state: 'missing' };
      if (i >= retries) return { state: 'unreadable', error: e };
      sleepSync(5); continue;
    }
    try { return { state: 'ok', holder: JSON.parse(text) }; } catch (e) {
      if (i >= retries) return { state: 'unreadable', error: e };
      sleepSync(5);
    }
  }
}

function readHolder(dir, resource) {
  const s = readFileState(lockPath(dir, resource));
  return s.state === 'ok' ? s.holder : null;
}

// ---- The guard: every UNLINK and every in-place REWRITE of a lock file happens under it.
//
// Creation needs no guard — `wx` succeeds at most once per name. What needs one is the stale
// takeover: without it, A and B both read a stale lock, A unlinks it and creates its own, and B —
// still acting on what it read — unlinks A's FRESH lock and creates a second. Both "hold" it. Under
// the guard the read and the unlink are one step, and a renewal or a release cannot interleave.
// The guard is itself a `wx` file; one left by a process that died inside it (they hold it for
// milliseconds) is broken after GUARD_STALE_MS.
const GUARD_STALE_MS = 5000;
const GUARD_WAIT_MS = 3000;
function withGuard(file, fn) {
  const g = file + '.guard';
  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    try { fs.writeFileSync(g, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let mtime;
      try { mtime = fs.statSync(g).mtimeMs; } catch { continue; } // released meanwhile — retry now
      if (Date.now() - mtime > GUARD_STALE_MS) { try { fs.unlinkSync(g); } catch { /* raced */ } continue; }
      if (Date.now() >= deadline) throw new Error(`coordination guard ${path.basename(g)} stayed busy for ${GUARD_WAIT_MS}ms`);
      sleepSync(5);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(g); } catch { /* already gone */ } }
}

// Replace a file's content atomically for readers (temp + rename). Windows refuses a rename onto
// a file another process has open for a moment, so the rename retries briefly.
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw e; }
      sleepSync(10);
    }
  }
}

// Remove a lock only if it is STILL the stale one that was read: same owner, same stamp, and
// still past its TTL, all checked under the guard.
function breakStale(file, seen, now) {
  return withGuard(file, () => {
    const s = readFileState(file, 0);
    if (s.state !== 'ok') return false;
    const cur = s.holder;
    if (cur.ts !== seen.ts || cur.holderId !== seen.holderId || core.lockStatus(cur, now) !== 'stale') return false;
    fs.unlinkSync(file);
    return true;
  });
}

// The acquire loop, for any lock file: create it with `wx`, or find out who has it. A stale holder
// is broken (under the guard) and the create retried; a live one is waited for until waitMs.
// opts.isMine(holder) — a re-entrant caller (the claim store) can say "that one is already mine".
// Returns { ok: true } | { ok: true, mine: true, holder } | { ok: false, holder }.
function acquireAt(file, makePayload, opts = {}) {
  const waitMs = opts.waitMs != null ? opts.waitMs : core.WAIT_MS;
  const pollMs = opts.pollMs != null ? opts.pollMs : core.POLL_MS;
  const stamp = () => (opts.now != null ? opts.now : Date.now());
  // Deadline is always real wall-clock so the loop terminates even with fixed opts.now.
  const deadline = Date.now() + waitMs;
  let vanished = 0;
  for (;;) {
    try {
      fs.writeFileSync(file, makePayload(), { flag: 'wx' });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const s = readFileState(file);
      if (s.state === 'missing' && vanished++ < 50) continue; // released between the create and the read
      const cur = s.state === 'ok' ? s.holder : null;
      if (cur && opts.isMine && opts.isMine(cur)) return { ok: true, mine: true, holder: cur };
      if (cur && core.lockStatus(cur, stamp()) === 'stale') { breakStale(file, cur, stamp()); continue; }
      if (Date.now() >= deadline) return { ok: false, holder: cur };
      sleepSync(pollMs);
    }
  }
}

function readLocks(dir) {
  let names = [];
  try { names = fs.readdirSync(locksDir(dir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(locksDir(dir), n), 'utf8'))); } catch { /* skip bad */ }
  }
  return out;
}

// holder: { holderId, terminal }. opts: { reason, ttlMs, waitMs, pollMs, now }.
// NOTE: deadline uses real wall-clock Date.now() so the loop terminates even when
// opts.now is a fixed test value (stamp() is frozen, but wall-clock always advances).
function acquire(dir, resource, holder, opts = {}) {
  ensureDir(dir);
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : core.CLI_TTL_MS;
  // stamp() returns fixed test value when opts.now provided, else live time.
  // Used for lock timestamps and staleness math.
  const stamp = () => (opts.now != null ? opts.now : Date.now());
  const payload = () => JSON.stringify({
    resource, holder: holder.terminal, holderId: holder.holderId,
    reason: opts.reason || '', pid: process.pid, ts: stamp(), ttlMs,
  });
  const r = acquireAt(lockPath(dir, resource), payload, opts);
  if (r.ok) appendBoard(dir, { ts: stamp(), terminal: holder.terminal, resource, status: 'START', detail: opts.reason || '-' });
  return r;
}

function release(dir, resource, holderId) {
  const file = lockPath(dir, resource);
  if (!readHolder(dir, resource)) return false; // nothing to release: no guard needed, and none made
  const cur = withGuard(file, () => {
    const s = readFileState(file, 0);
    if (s.state !== 'ok' || s.holder.holderId !== holderId) return null;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return s.holder;
  });
  if (!cur) return false;
  appendBoard(dir, { ts: Date.now(), terminal: cur.holder, resource, status: 'DONE', detail: cur.reason || '-' });
  return true;
}

function note(dir, terminal, message) {
  appendBoard(dir, { ts: Date.now(), terminal, resource: '-', status: 'NOTE', detail: message });
}

// Background Task/Agent tool lifecycle: resource encodes `task:<tileId>:<taskId>` so the
// dashboard can derive "currently running" (a START with no later DONE for that key) and
// resolve which tile to focus on click, purely from the existing board.md feed.
function taskEvent(dir, terminal, tileId, taskId, status, detail) {
  appendBoard(dir, { ts: Date.now(), terminal, resource: `task:${tileId}:${taskId}`, status, detail: detail || '-' });
}

function appendChat(dir, terminal, message) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'chat.md'), core.formatChatLine({ ts: Date.now(), terminal, message }), 'utf8');
}

// GOD-only outbox: drop one atomic JSON command for the renderer to drain. temp + rename so
// the watcher never reads a half-written file; one file per message. This is the overseer's own
// channel, not an integration point: a process outside the app uses the connector channel
// (docs/api.md, wcc-client) — writing here instead would be impersonating Kane's authority
// (docs/architecture.md, "Two ways in"). Record shapes: src/terminals/god.ts OutboxMessage.
//
// Every request carries `from`: the sender's COS_SESSION_ID, or null when it has none (an older
// app, a shell outside the app). Attribution only — the app records it as the spawned session's
// parent; it never decides what a request is allowed to do.
function dropOutbox(dir, obj, from) {
  const outbox = path.join(dir, 'god-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const final = path.join(outbox, `${ts}-${rand}.json`);
  const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ts, ...obj, from: from || null }), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}
function tell(dir, target, message, from) { return dropOutbox(dir, { kind: 'tell', target, message }, from); }
function watch(dir, target, note, from) { return dropOutbox(dir, { kind: 'watch', target, note }, from); }
// extra: { workstream, role, from, taskClass, writes, isolation } — fields added after the positional ones, null when unset.
function spawn(dir, repo, base, task, model, effort, name, extra = {}) {
  return dropOutbox(dir, { kind: 'spawn', repo, base: base || null, task, model: model || null, effort: effort || null, name: name || null, workstream: extra.workstream || null, role: extra.role || null, taskClass: extra.taskClass || null, writes: extra.writes || null, isolation: extra.isolation || null }, extra.from);
}
function rename(dir, target, to, from) { return dropOutbox(dir, { kind: 'rename', target, name: to }, from); }
function personality(dir, from) { return dropOutbox(dir, { kind: 'personality' }, from); }
function close(dir, target, from) { return dropOutbox(dir, { kind: 'close', target }, from); }
// `fields` is new-tab-core.cjs buildNewTabFields' output: { name, repo, newRepo, parent, … }.
function newTab(dir, fields, from) { return dropOutbox(dir, { kind: 'new-tab', ...fields }, from); }

// Take back a request the app has not drained. The app claims a drop by renaming it into .done/
// before acting on it (terminals-grid.ts drainOutbox), so exactly one of the two wins: true means
// it was withdrawn and will never run, false means the app already had it.
function withdraw(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// A `tell`'s receipt: the app writes one of these to god-outbox/.receipts/<id>.json once it
// KNOWS whether the message actually landed on the target's screen (see terminals-grid.ts
// dispatchOutbox/writeTellReceipt) — not just once it has dropped the request file, which is
// all `dropOutbox` above ever guaranteed. This is new: no receipt existed for any command
// before this, so there is no prior shape to preserve; the outbox REQUEST shape tell() writes
// above is untouched.
function receiptPath(dir, id) { return path.join(dir, 'god-outbox', '.receipts', `${id}.json`); }

// Block (synchronously — this runs inside a one-shot CLI process, same shape as acquire()'s
// wait/poll) until that receipt shows up, or waitMs elapses. No receipt within the window is
// reported the same as an explicit failure: a CLI caller must never read silence as success.
// `close` files its outcome on the same seam; opts.timeoutReason lets it word the timeout for
// what it actually is (a close that may still happen), not as a missing delivery.
function waitForTellReceipt(dir, id, opts = {}) {
  const waitMs = opts.waitMs != null ? opts.waitMs : core.TELL_WAIT_MS;
  const pollMs = opts.pollMs != null ? opts.pollMs : core.POLL_MS;
  const file = receiptPath(dir, id);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      try { fs.unlinkSync(file); } catch { /* best-effort cleanup */ }
      return r;
    } catch { /* not written yet, or unreadable mid-write — keep polling */ }
    if (Date.now() >= deadline) return { ok: false, timedOut: true, reason: opts.timeoutReason || 'timed out waiting for the app to confirm delivery — is it running?' };
    sleepSync(pollMs);
  }
}

module.exports = {
  acquire, release, readLocks, readHolder, appendBoard, note, taskEvent, appendChat,
  acquireAt, withGuard, writeAtomic, readFileState, breakStale,
  tell, watch, spawn, rename, personality, close, newTab, withdraw, dropOutbox, sleepSync,
  receiptPath, waitForTellReceipt,
};
