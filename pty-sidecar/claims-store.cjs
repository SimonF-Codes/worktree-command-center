'use strict';
// Write claims (V2 ladder step 9) — the IO half. A machine-wide `_claims/` directory beside the
// per-workspace coordination directories (<userData>/.coordination/_claims/), because a checkout
// is shared across workspace tabs while `locks/` is per workspace (E1).
//
// Built ON coord-store's lock primitive, not beside it (FR-13): the same `wx` create (acquireAt),
// the same staleness rule (lockStatus), the same guard for every unlink and rewrite (withGuard).
// What a claim adds to a lock:
//  - one file per CHECKOUT ROOT, named write-<sha1(checkout id)>.json (claims-core claimFileName);
//  - the stable `sessionId` (E2: tile ids are reissued on every restore) and the isolation `mode`;
//  - a LEASE: the holder re-stamps `ts` after every write (renewClaim, from the PostToolUse hook),
//    so a dead session stops renewing and its claim goes stale on its own.
//
// Fails by throwing, like coord-store. Whether a throw ALLOWS or DENIES is the caller's, and for
// the write hook it is coord-hook.cjs failurePolicyFor(mode) — nowhere else.
const fs = require('fs');
const path = require('path');
const store = require('./coord-store.cjs');
const cc = require('./claims-core.cjs');

const CLAIM_FILE = /^write-[0-9a-f]{40}\.json$/;

/** The machine-wide claims directory under the coordination root (<userData>/.coordination). */
function claimsDirUnder(coordRoot) { return path.join(path.resolve(coordRoot), '_claims'); }

/** The same directory, from one workspace's coordination directory: its sibling. */
function claimsDirOf(coordDir) { return claimsDirUnder(path.dirname(path.resolve(coordDir))); }

function claimPath(dir, checkoutId) { return path.join(dir, cc.claimFileName(checkoutId)); }

/** Create the directory. The APP does this (at start, and before a spawn-time acquire); the write
 *  hook never does — under the closed failure policy a missing directory must deny, not be
 *  quietly recreated empty. */
function ensureClaimsDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

/** Every claim in the store.
 *  strict (the write hook of a shared session): a missing directory, an unreadable directory or an
 *  unreadable claim file THROWS — any of them could be hiding the claim that matters.
 *  lenient (status displays, the move planner's courtesy read): missing reads as none, a bad file
 *  is skipped. */
function readClaims(dir, opts = {}) {
  const strict = !!opts.strict;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (!strict && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const n of names) {
    if (!CLAIM_FILE.test(n)) continue; // guards, temp files, anything else
    const s = store.readFileState(path.join(dir, n));
    if (s.state === 'missing') continue; // released between the listing and the read
    if (s.state === 'unreadable') {
      if (strict) throw new Error(`claim file ${n} is unreadable: ${s.error && s.error.message}`);
      continue;
    }
    out.push(s.holder);
  }
  return out;
}

function claimPayload(checkout, who, now, ttlMs) {
  const id = cc.checkoutId(checkout);
  return {
    v: 1, resource: cc.writeResource(id), checkoutId: id, path: path.resolve(checkout),
    sessionId: who.sessionId, holderId: who.sessionId, holder: who.holder || who.sessionId,
    mode: who.mode || 'shared-write', reason: who.reason || '', pid: process.pid, ts: now, ttlMs,
  };
}

function boardEvent(boardDir, claim, status) {
  if (!boardDir) return;
  try { store.appendBoard(boardDir, { ts: Date.now(), terminal: claim.holder, resource: `write:${claim.path}`, status, detail: claim.reason || claim.mode || '-' }); }
  catch { /* the feed is a courtesy; the claim file is the fact */ }
}

/**
 * Take the lease on a checkout, or renew it if this session already holds it.
 * who: { sessionId, holder, mode, reason }. opts: { now, ttlMs, boardDir }.
 * → { ok: true, acquired: true } | { ok: true, renewed: true } | { ok: false, holder }
 * Never waits: a lease is long, and the caller's answer to "held" is a refusal (or FR-12's
 * fallback to a worktree), not a queue.
 */
function takeClaim(dir, checkout, who, opts = {}) {
  if (!who || !who.sessionId) throw new Error('a claim needs the session id of its holder');
  const now = opts.now != null ? opts.now : Date.now();
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : cc.CLAIM_TTL_MS;
  const file = claimPath(dir, cc.checkoutId(checkout));
  const payload = claimPayload(checkout, who, now, ttlMs);
  const r = store.acquireAt(file, () => JSON.stringify(payload), { waitMs: 0, now, isMine: (h) => h.sessionId === who.sessionId });
  if (!r.ok) return { ok: false, holder: r.holder };
  if (r.mine) {
    // Already ours — re-stamp it. renewClaim re-checks ownership under the guard, so a takeover
    // that landed between the read and now is not overwritten.
    if (renewClaim(dir, checkout, who.sessionId, { now })) return { ok: true, renewed: true };
    return takeClaim(dir, checkout, who, opts);
  }
  boardEvent(opts.boardDir, payload, 'START');
  return { ok: true, acquired: true };
}

/** Re-stamp this session's lease (the PostToolUse renewal). Under the guard: read, check it is
 *  still this session's, rewrite atomically. false = not held by this session (any more). */
function renewClaim(dir, checkout, sessionId, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const file = claimPath(dir, cc.checkoutId(checkout));
  return store.withGuard(file, () => {
    const s = store.readFileState(file, 0);
    if (s.state !== 'ok' || s.holder.sessionId !== sessionId) return false;
    store.writeAtomic(file, JSON.stringify({ ...s.holder, ts: now, pid: process.pid }));
    return true;
  });
}

/** Give a lease up. Only its holder can; the caller checks the tree is clean first
 *  (claims-core releaseRefusal). → the released claim, or null when it was not this session's. */
function releaseClaim(dir, checkout, sessionId, opts = {}) {
  const file = claimPath(dir, cc.checkoutId(checkout));
  const s0 = store.readFileState(file);
  if (s0.state !== 'ok' || s0.holder.sessionId !== sessionId) return null;
  const cur = store.withGuard(file, () => {
    const s = store.readFileState(file, 0);
    if (s.state !== 'ok' || s.holder.sessionId !== sessionId) return null;
    fs.unlinkSync(file);
    return s.holder;
  });
  if (cur) boardEvent(opts.boardDir, cur, 'DONE');
  return cur;
}

/** Every claim this session holds (lenient read: used to release them when it ends). */
function claimsOf(dir, sessionId) { return readClaims(dir).filter((c) => c.sessionId === sessionId); }

/**
 * After a repo move: re-point every claim whose path the move changed (remap: old path → new
 * path, i.e. move-repo's remapPath over the plan's path map — the same rewrite the sessions file
 * gets). The file is renamed with it, since its name is derived from the path. A claim already at
 * the destination name is left alone and reported. → { changed, conflicts: string[] }
 */
function remapClaims(dir, remap) {
  const out = { changed: 0, conflicts: [] };
  for (const c of readClaims(dir)) {
    if (!c || !c.path) continue;
    const to = remap(c.path);
    if (!to || cc.checkoutId(to) === cc.checkoutId(c.path)) continue;
    const from = claimPath(dir, cc.checkoutId(c.path));
    const dest = claimPath(dir, cc.checkoutId(to));
    store.withGuard(from, () => {
      const s = store.readFileState(from, 0);
      if (s.state !== 'ok' || s.holder.sessionId !== c.sessionId) return; // changed under us
      const id = cc.checkoutId(to);
      try {
        fs.writeFileSync(dest, JSON.stringify({ ...s.holder, path: path.resolve(to), checkoutId: id, resource: cc.writeResource(id) }), { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        out.conflicts.push(`${c.path} → ${to}: a claim already exists there`);
        return;
      }
      fs.unlinkSync(from);
      out.changed++;
    });
  }
  return out;
}

// ---- The automatic git locks (Q12): `push:<repo>` and `worktree:<repo>`, taken by the git hook
// around a `git push` / `git worktree add`. Same directory, same acquireAt, same guard as a lease —
// they used to live in each workspace's locks/, so two tabs could push one repo at once (E1 again).
// `repo` is claims-core repoIdentity: keyed on the repository, so every worktree of it shares one.
// `who.holderId` is the session id (tile ids repeat across workspaces, so they cannot own a
// machine-wide lock). A holder taking its own lock again re-stamps it instead of waiting on itself.

const GIT_LOCK_FILE = /^git-(push|worktree)-[0-9a-f]{40}\.json$/;

function gitLockPath(dir, kind, key) { return path.join(dir, cc.gitLockFileName(kind, key)); }

/** → { ok: true } | { ok: true, mine: true } | { ok: false, holder }. opts: waitMs, pollMs, now,
 *  ttlMs, reason, boardDir (the session's own workspace feed, which gets START as before). */
function takeGitLock(dir, kind, repo, who, opts = {}) {
  const file = gitLockPath(dir, kind, repo.key);
  const stamp = () => (opts.now != null ? opts.now : Date.now());
  const resource = `${kind}:${repo.name}`;
  const payload = () => JSON.stringify({
    v: 1, resource, repo: repo.key, holder: who.holder || String(who.holderId), holderId: who.holderId,
    reason: opts.reason || kind, pid: process.pid, ts: stamp(), ttlMs: opts.ttlMs != null ? opts.ttlMs : cc.CLAIM_TTL_MS,
  });
  const r = store.acquireAt(file, payload, { waitMs: opts.waitMs, pollMs: opts.pollMs, now: opts.now, isMine: (h) => h.holderId === who.holderId });
  if (r.ok && r.mine) {
    store.withGuard(file, () => {
      const s = store.readFileState(file, 0);
      if (s.state === 'ok' && s.holder.holderId === who.holderId) store.writeAtomic(file, JSON.stringify({ ...s.holder, ts: stamp(), pid: process.pid }));
    });
    return { ok: true, mine: true };
  }
  if (r.ok && opts.boardDir) {
    try { store.appendBoard(opts.boardDir, { ts: stamp(), terminal: who.holder, resource, status: 'START', detail: opts.reason || kind }); } catch { /* the feed is a courtesy */ }
  }
  return r;
}

/** Release a git lock this holder owns (under the guard). → the released record, or null. */
function releaseGitLock(dir, kind, repo, holderId, opts = {}) {
  const file = gitLockPath(dir, kind, repo.key);
  const s0 = store.readFileState(file);
  if (s0.state !== 'ok' || s0.holder.holderId !== holderId) return null;
  const cur = store.withGuard(file, () => {
    const s = store.readFileState(file, 0);
    if (s.state !== 'ok' || s.holder.holderId !== holderId) return null;
    fs.unlinkSync(file);
    return s.holder;
  });
  if (cur && opts.boardDir) {
    try { store.appendBoard(opts.boardDir, { ts: Date.now(), terminal: cur.holder, resource: cur.resource, status: 'DONE', detail: cur.reason || '-' }); } catch { /* courtesy */ }
  }
  return cur;
}

/** Every git lock on the machine (lenient: a display). */
function readGitLocks(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!GIT_LOCK_FILE.test(n)) continue;
    const s = store.readFileState(path.join(dir, n));
    if (s.state === 'ok') out.push(s.holder);
  }
  return out;
}

module.exports = {
  takeGitLock, releaseGitLock, readGitLocks, gitLockPath,
  claimsDirUnder, claimsDirOf, claimPath, ensureClaimsDir, readClaims, takeClaim, renewClaim, releaseClaim, claimsOf, remapClaims,
};
