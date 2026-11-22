'use strict';
// Write claims (V2 ladder step 9) — the PURE half. No IO: given the session's facts, the claims
// already read from `_claims/` and the path a file tool is about to write, say what the write hook
// must do. Shared by coord-hook.cjs (the hook), coord-cli.cjs (`cos-coord lease`), claims-store.cjs
// (file names) and, through claims-core.d.cts, the app (src/core/isolation.ts, src/move-repo*.ts).
//
// The unit of exclusion is a CHECKOUT ROOT, never a path prefix (design D4): exclusion is atomic
// only because there is one file per resource and `wx` creates a name at most once. Claims on
// C:/dev/x and C:/dev/x/src would be two files, and both creates would succeed.
//
// This is a COOPERATIVE guarantee, not a sandbox: it sees Claude's file tools (Edit, Write,
// MultiEdit, NotebookEdit) and nothing else. A shell redirect or a build script writes without
// passing through here. docs/api.md, "Write claims", says so plainly.

const crypto = require('crypto');
const path = require('path');
const { lockStatus, GIT_TTL_MS } = require('./coord-core.cjs');

/** A lease lives 10 minutes unless its holder writes again (the PostToolUse re-stamp), like the
 *  automatic git locks. A dead session stops renewing and its lease goes stale by itself. */
const CLAIM_TTL_MS = GIT_TTL_MS;

/** Where the app nests a repo's worktrees (src/terminals/worktree-manager.ts WORKTREES_DIR — a
 *  drift test holds the two equal). A checkout's lease does not cover it: those are other
 *  sessions' worktrees, each exclusive by construction (Q9, the lenient reading). */
const WORKTREES_DIR = '.claude-worktrees';

/** The isolation modes (src/core/isolation.ts Mode). */
const MODES = ['worktree', 'shared-readonly', 'shared-write', 'scratch'];

// The failure policy — whether an error in the write gate allows or denies the write — is NOT
// here. It is coord-hook.cjs failurePolicyFor(mode): one named function, in the one file that
// applies it, dependency-free so it holds even when this module fails to load.

// ---------------------------------------------------------------------------------------------
// Names

/** A checkout's id: its resolved path, forward slashes, lower case, no trailing separator. The
 *  same spelling step 8's planIsolation used (src/core/isolation.ts checkoutIdOf calls this).
 *  Lower case on every platform: on a case-sensitive disk two checkouts differing only in case
 *  would share one lease — over-exclusion, the safe direction. */
function checkoutId(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').toLowerCase(); // resolve drops a trailing separator
}

function writeResource(id) { return `write:${id}`; }

/** `write-<sha1(id)>.json`: a slug would collapse punctuation, so two checkouts could share one
 *  name (design §2 "Name"). The payload keeps the readable path. */
function claimFileName(id) {
  return `write-${crypto.createHash('sha1').update(String(id)).digest('hex')}.json`;
}

/** `target` is `root` itself or below it, separator-bounded (C:/dev/app2 is not inside C:/dev/app). */
function isInside(target, root) {
  const t = checkoutId(target), r = checkoutId(root);
  return t === r || t.startsWith(r.endsWith('/') ? r : r + '/');
}

/** Does this claim's lease cover a write to `target`? Its checkout, minus the nested worktree
 *  root — writes in another session's worktree do not touch this checkout. */
function claimCovers(claim, target) {
  if (!claim || !claim.path) return false;
  return isInside(target, claim.path) && !isInside(target, path.join(claim.path, WORKTREES_DIR));
}

function claimIsLive(claim, now) { return lockStatus(claim, now) === 'held'; }

function ageStr(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`; }

function holderName(c) { return (c && (c.holder || c.sessionId)) || 'another session'; }

// ---------------------------------------------------------------------------------------------
// Escalation (FR-16): a shared-readonly session's first write is where its claim is tested.

/** Would decideIsolation grant shared-write to this session for a repo write? The same answer,
 *  kept equal by a test (tests/claims-core.test.ts) over every class: only the `cheapest-safe`
 *  policy grants it, never to a read-only rung, and never for `feature` work (which needs its
 *  own branch). An unknown rung or class reads as the conservative one. */
function canEscalate(policy, rung, taskClass) {
  if (policy !== 'cheapest-safe') return false;
  if (rung !== 'write') return false;
  return ['small-fix', 'config', 'investigate', 'doc', 'release'].includes(taskClass);
}

// ---------------------------------------------------------------------------------------------
// The decision

/**
 * What the write hook does with one file-tool write.
 *
 * in: {
 *   mode,       // COS_ISOLATION, or undefined
 *   checkout,   // the session's checkout root: its worktree, or the shared checkout (COS_CHECKOUT)
 *   sessionId,  // COS_SESSION_ID — the claim's owner, stable across restores
 *   policy, rung, taskClass,   // for a shared-readonly session's escalation
 *   target,     // the absolute path the tool will write
 *   claims,     // every claim in _claims/, as read
 *   now,
 * }
 * out: { verdict: 'allow' }
 *    | { verdict: 'claim', escalate: boolean }  — take (or renew) the lease on `checkout`, then allow
 *    | { verdict: 'deny', reason, holder, path } — FR-17: names both, always
 */
function decideWrite(i) {
  const target = i.target;
  const now = i.now;
  const me = i.sessionId || '';
  const mode = i.mode || undefined;
  const claims = Array.isArray(i.claims) ? i.claims : [];
  const deny = (reason, holder, p) => ({ verdict: 'deny', reason, holder, path: p });

  // 1. Someone else's LIVE lease covers this file: nobody else writes there, whatever its mode.
  const other = claims.find((c) => c && c.sessionId !== me && claimIsLive(c, now) && claimCovers(c, target));
  if (other) {
    return deny(
      `Write claim: ${other.path} is held by ${holderName(other)} (lease ${ageStr(now - other.ts)} old), so ${target} cannot be written from this session. `
      + 'Do not work around this with a shell command — that checkout is another session\'s to write right now. '
      + 'Stop and say the task needs to be respawned in its own worktree, or wait for that lease to end.',
      holderName(other), other.path,
    );
  }

  const shared = mode === 'shared-readonly' || mode === 'shared-write' || mode === 'scratch';
  if (!shared) return { verdict: 'allow' }; // a worktree / folder / pre-step-9 session: its own checkout

  const checkout = i.checkout;
  if (!checkout) return deny(`Write claim: this ${mode} session has no checkout recorded (COS_CHECKOUT), so the hook cannot tell what ${target} touches — the write is denied.`, `${mode} session`, target);

  // Inside a nested worktree of the shared checkout: another session's worktree. Never ours.
  if (isInside(target, path.join(checkout, WORKTREES_DIR))) {
    return deny(`Write claim: ${target} is inside ${path.join(checkout, WORKTREES_DIR)} — another session's worktree, not part of this ${mode} checkout. Do not write there.`, 'another session\'s worktree', target);
  }
  if (!isInside(target, checkout)) return { verdict: 'allow' }; // outside the checkout: no lease applies

  if (mode === 'scratch') {
    return deny(`Write claim: this is a scratch session — it writes only in its scratch folder or a vault path its brief names, never inside ${checkout}. Stop and say the task needs a repository change; it must be respawned with its own worktree.`, 'scratch mode', checkout);
  }
  if (mode === 'shared-write') return { verdict: 'claim', escalate: false };

  // shared-readonly: escalate at the moment of the write, or refuse.
  if (canEscalate(i.policy, i.rung, i.taskClass)) return { verdict: 'claim', escalate: true };
  const why = i.rung !== 'write'
    ? 'its role is a read-only rung'
    : i.policy !== 'cheapest-safe'
      ? `the isolation setting is "${i.policy || 'worktree-always'}", which never lets a shared session write`
      : `its task class is "${i.taskClass || 'feature'}", which needs its own branch`;
  return deny(
    `Write claim: this session is shared-readonly — ${checkout} is a shared checkout other sessions use, and ${why}, so ${target} cannot be written. `
    + 'Do not work around this with a shell command. Stop and say the task needs a write; it must be respawned with its own worktree.',
    'shared-readonly mode', checkout,
  );
}

/** The refusal when a claim could not be taken because someone holds it (the store's answer). */
function heldMessage(holder, checkout, target, now) {
  const age = holder && typeof holder.ts === 'number' ? ` (lease ${ageStr(now - holder.ts)} old)` : '';
  return `Write claim: ${checkout} is held by ${holderName(holder)}${age}, so ${target} cannot be written from this session. `
    + 'Do not work around this with a shell command. Stop and say the task needs to be respawned in its own worktree, or wait for that lease to end.';
}

/** The refusal under the closed failure policy: the store could not be consulted at all. */
function failClosedMessage(mode, target, err) {
  return `Write claim: the lease store could not be read (${err}), and this is a ${mode} session — on a shared checkout the hook is the only guard, so the write to ${target} is DENIED rather than allowed. Stop and report this; do not write with a shell command instead.`;
}

/** A release must leave the checkout clean — it is how a shell write the hook could not see gets
 *  noticed (design §2, mitigation 2). `porcelain` is `git status --porcelain` output, or null when
 *  git could not be asked (which refuses too: an unknown tree is not a clean one). */
function releaseRefusal(porcelain, checkout) {
  if (porcelain == null) return `${checkout}: git status failed, so the checkout cannot be shown clean — the lease is kept.`;
  const lines = String(porcelain).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  if (!lines.length) return null;
  const sample = lines.slice(0, 3).map((l) => l.slice(3)).join(', ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : '');
  return `${checkout} has ${lines.length} uncommitted change${lines.length === 1 ? '' : 's'} (${sample}) — commit or discard them first; the lease is kept until then (or until it expires).`;
}

// ---------------------------------------------------------------------------------------------
// The automatic git locks (Q12): `push` and `worktree add`, machine-wide like the write leases.
//
// Keyed on the REPOSITORY — its git common dir — not on the directory the command ran in. Before
// this, the lock was named after the basename of the session's cwd, so every worktree session got
// its own (push:wt-main-53, push:wt-main-45, …) and two sessions pushing one repo never contended.

/** push → 'push'; worktree-add → 'worktree' (the resource prefixes coord-core gitResource uses). */
function gitLockKind(op) { return op === 'push' ? 'push' : 'worktree'; }

/** A repository's identity from `git rev-parse --git-common-dir`, run in `ranIn` (git prints it
 *  relative to there). Every worktree of one repo shares the common dir, so they share the key.
 *  `name` is the repo's folder, for the human-readable resource (`push:<name>`). */
function repoIdentity(commonDirOut, ranIn) {
  const common = path.resolve(String(ranIn), String(commonDirOut).trim());
  const root = path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : common;
  return { key: checkoutId(common), name: path.basename(root) };
}

/** Used only when git cannot name the repository (not a repo, an unexpanded `$d`): the lock is
 *  named as it was before Q12, by the target folder's name. */
function legacyRepoIdentity(name) { return { key: `name:${String(name).toLowerCase()}`, name: String(name) }; }

/** `git-<kind>-<sha1(key)>.json`, beside the write leases in `_claims/`. */
function gitLockFileName(kind, key) {
  return `git-${kind}-${crypto.createHash('sha1').update(String(key)).digest('hex')}.json`;
}

/** The file path a file tool writes, from its hook input. NotebookEdit names it notebook_path. */
function toolTarget(input) {
  const ti = (input && input.tool_input) || {};
  const p = ti.file_path || ti.notebook_path || ti.path || '';
  if (!p) return '';
  return path.resolve(input.cwd || process.cwd(), String(p));
}

module.exports = {
  CLAIM_TTL_MS, WORKTREES_DIR, MODES,
  checkoutId, writeResource, claimFileName, isInside, claimCovers, claimIsLive,
  canEscalate, decideWrite, heldMessage, failClosedMessage, releaseRefusal, toolTarget, ageStr,
  gitLockKind, repoIdentity, legacyRepoIdentity, gitLockFileName,
};
