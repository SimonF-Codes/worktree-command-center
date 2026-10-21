'use strict';
// IO layer: atomic per-resource locks + append-only board. Fails by throwing;
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

function readHolder(dir, resource) {
  try { return JSON.parse(fs.readFileSync(lockPath(dir, resource), 'utf8')); }
  catch { return null; }
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
  const now = opts.now != null ? opts.now : Date.now();
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : core.CLI_TTL_MS;
  const waitMs = opts.waitMs != null ? opts.waitMs : core.WAIT_MS;
  const pollMs = opts.pollMs != null ? opts.pollMs : core.POLL_MS;
  const file = lockPath(dir, resource);
  // stamp() returns fixed test value when opts.now provided, else live time.
  // Used for lock timestamps and staleness math.
  const stamp = () => (opts.now != null ? opts.now : Date.now());
  const payload = () => JSON.stringify({
    resource, holder: holder.terminal, holderId: holder.holderId,
    reason: opts.reason || '', pid: process.pid, ts: stamp(), ttlMs,
  });
  // Deadline is always real wall-clock so the loop terminates even with fixed opts.now.
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, payload(), { flag: 'wx' });
      appendBoard(dir, { ts: stamp(), terminal: holder.terminal, resource, status: 'START', detail: opts.reason || '-' });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readHolder(dir, resource);
      if (core.lockStatus(cur, stamp()) === 'stale') {
        try { fs.unlinkSync(file); } catch { /* race: someone else took it */ }
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, holder: cur };
      sleepSync(pollMs);
    }
  }
}

function release(dir, resource, holderId) {
  const cur = readHolder(dir, resource);
  if (!cur || cur.holderId !== holderId) return false;
  try { fs.unlinkSync(lockPath(dir, resource)); } catch { /* already gone */ }
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
function dropOutbox(dir, obj) {
  const outbox = path.join(dir, 'god-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const final = path.join(outbox, `${ts}-${rand}.json`);
  const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ts, ...obj }), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}
function tell(dir, target, message) { return dropOutbox(dir, { kind: 'tell', target, message }); }
function watch(dir, target, note) { return dropOutbox(dir, { kind: 'watch', target, note }); }
function spawn(dir, repo, base, task, model, effort, name) { return dropOutbox(dir, { kind: 'spawn', repo, base: base || null, task, model: model || null, effort: effort || null, name: name || null }); }
function rename(dir, target, to) { return dropOutbox(dir, { kind: 'rename', target, name: to }); }
function personality(dir) { return dropOutbox(dir, { kind: 'personality' }); }
function close(dir, target) { return dropOutbox(dir, { kind: 'close', target }); }
// `fields` is new-tab-core.cjs buildNewTabFields' output: { name, repo, newRepo, parent, … }.
function newTab(dir, fields) { return dropOutbox(dir, { kind: 'new-tab', ...fields }); }

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
  tell, watch, spawn, rename, personality, close, newTab, withdraw, dropOutbox, sleepSync,
  receiptPath, waitForTellReceipt,
};
