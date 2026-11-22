'use strict';
// Pre/PostToolUse hook, three independent modes:
//  - Bash matcher (default): auto-lock `git push` / `git worktree add` per REPOSITORY, machine-wide
//    (the locks live in `_claims/`, keyed on the git common dir — Q12, V2 step 9).
//    PreToolUse (no arg): acquire; deny via JSON if held; allow (exit 0) otherwise.
//    PostToolUse (--release): release if we hold it.
//  - Task matcher (--task): log a background-task START/DONE board event (--task --release
//    on PostToolUse = DONE). No locking — tasks don't contend, we just log the lifecycle.
//  - File-tool matcher (--write, V2 step 9): the write gate for Edit / Write / MultiEdit /
//    NotebookEdit. PreToolUse tests the write against the machine-wide `_claims/` store — and for a
//    shared-readonly session it is where the claim is first tested (FR-16); PostToolUse
//    (--write --renew) re-stamps the session's lease, which is what keeps it alive.
//
// TWO OPPOSITE FAILURE POLICIES live in this file, deliberately:
//  - The Bash and Task modes are FAIL-OPEN: any error exits 0 (allow). Their locks are a
//    convenience between worktree sessions, and a broken lock must not stop ordinary work.
//  - The write gate's policy is failurePolicyFor(COS_ISOLATION), below — the one place it is
//    decided. Fail-open for a worktree session (its checkout is its own); FAIL-CLOSED for a shared
//    or scratch session, where this hook is the only guard on a real checkout: an unreadable store,
//    a missing directory, a bad environment, a module that will not load or a thrown error DENIES.
// Reads hook JSON from stdin.
//
// What this hook cannot see: a write that is not a file tool — a shell redirect, a build script.
// It is a cooperative guarantee, not a sandbox (docs/api.md, "Write claims").

const fs = require('fs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function env(name, dflt) { return process.env[name] != null ? process.env[name] : dflt; }

// ---- The write gate's failure policy. ONE place, named, a function of the isolation mode only.
// Dependency-free on purpose: it must be decidable even when nothing else in the sidecar loads.
//  'open'   — no mode recorded (a plain folder target, Kane, a session from before step 8) or
//             `worktree`: an error allows the write.
//  'closed' — shared-readonly, shared-write, scratch, or a mode string this code does not know
//             (the app set it, so the session is not an ordinary one): an error denies the write.
function failurePolicyFor(mode) {
  if (mode == null || mode === '' || mode === 'worktree') return 'open';
  return 'closed';
}

function denyJson(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

function writeGate(raw, renew) {
  const mode = env('COS_ISOLATION') || undefined;
  const failure = failurePolicyFor(mode);
  let target = '(unknown file)';
  try {
    const cc = require('./claims-core.cjs');
    const claimsStore = require('./claims-store.cjs');
    const input = JSON.parse(raw || '{}');
    target = cc.toolTarget(input) || target;
    const sessionId = env('COS_SESSION_ID', '');
    const coordDir = env('COS_COORD_DIR');
    const claimsDir = env('COS_CLAIMS_DIR') || (coordDir ? claimsStore.claimsDirOf(coordDir) : '');
    if (!claimsDir) throw new Error('no claims directory: COS_CLAIMS_DIR and COS_COORD_DIR are both unset');
    const shared = failure === 'closed';
    const checkout = env('COS_CHECKOUT') || (shared ? '' : (input.cwd || process.cwd()));

    if (renew) {
      // PostToolUse: the write happened. Re-stamp this session's lease, if it holds one. A
      // worktree session never holds one, so it does not even look.
      if (shared && checkout && sessionId) claimsStore.renewClaim(claimsDir, checkout, sessionId);
      return;
    }
    if (target === '(unknown file)') throw new Error('the tool input names no file path');

    const claims = claimsStore.readClaims(claimsDir, { strict: shared });
    const now = Date.now();
    const d = cc.decideWrite({
      mode, checkout, sessionId, target, claims, now,
      policy: env('COS_ISOLATION_POLICY'), rung: env('COS_RUNG'), taskClass: env('COS_TASK_CLASS'),
    });
    if (d.verdict === 'allow') return;
    if (d.verdict === 'deny') { denyJson(d.reason); return; }
    // 'claim': take the lease on this checkout (or renew our own) — the SAME wx create as every lock.
    if (!sessionId) throw new Error('this session has no COS_SESSION_ID, so it cannot hold a claim');
    const r = claimsStore.takeClaim(claimsDir, checkout, {
      sessionId, holder: env('COS_TERMINAL_NAME', sessionId), mode: d.escalate ? 'shared-readonly→write' : mode, reason: d.escalate ? 'escalated at first write' : 'shared-write',
    }, { boardDir: coordDir });
    if (!r.ok) denyJson(cc.heldMessage(r.holder, checkout, target, now));
  } catch (e) {
    if (renew || failure === 'open') return; // after the fact there is nothing to deny; open allows
    const why = (e && e.message) || String(e);
    try {
      const cc = require('./claims-core.cjs');
      denyJson(cc.failClosedMessage(mode, target, why));
    } catch {
      denyJson(`Write claim: the write gate failed (${why}) in a ${mode} session, so the write to ${target} is DENIED rather than allowed. Stop and report this.`);
    }
  }
}

function main() {
  const raw = readStdin();
  if (process.argv.includes('--write')) { writeGate(raw, process.argv.includes('--renew')); process.exit(0); }

  const core = require('./coord-core.cjs');
  const store = require('./coord-store.cjs');
  const dir = env('COS_COORD_DIR');
  if (!dir) process.exit(0);
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const terminal = env('COS_TERMINAL_NAME', `pid${process.pid}`);
  const holderId = Number(env('COS_TERMINAL_ID', String(process.pid)));
  const release = process.argv.includes('--release');

  if (process.argv.includes('--task')) {
    const taskId = String(input.tool_use_id || `${Date.now()}-${process.pid}`);
    const label = core.taskLabel(input.tool_input || {});
    store.taskEvent(dir, terminal, holderId, taskId, release ? 'DONE' : 'START', label);
    process.exit(0);
  }

  const command = (input.tool_input && input.tool_input.command) || '';
  const cwd = input.cwd || process.cwd();
  const op = core.parseGitOp(command);
  if (!op) process.exit(0);
  // A placeholder target (`git -C <repo> worktree add …` written into a doc or a heredoc) is not a
  // real git operation: allow it and take no lock. A lock taken on "<repo>" outlives the session
  // that only wrote about it, and in the machine-wide store (Q12) every tab sees it. Allow, not
  // deny: these locks are fail-open for worktree sessions (D5). The release side declines too.
  if (!core.isPlausibleTarget(core.resolveTargetPath(command, cwd))) process.exit(0);

  // Q12: the git locks are machine-wide (`_claims/`, beside the write leases) and keyed on the
  // repository, so every tab and every worktree of one repo share one push lock and one
  // worktree-add lock. Owned by the session id: tile ids repeat across workspaces. Still
  // fail-open — a missing store throws, and the catch below allows.
  const cc = require('./claims-core.cjs');
  const claimsStore = require('./claims-store.cjs');
  const claimsDir = env('COS_CLAIMS_DIR') || claimsStore.claimsDirOf(dir);
  const kind = cc.gitLockKind(op);
  const repo = repoOf(cc, core, command, cwd);
  const owner = env('COS_SESSION_ID') || `${dir}#${holderId}`;
  if (release) { claimsStore.releaseGitLock(claimsDir, kind, repo, owner, { boardDir: dir }); process.exit(0); }

  const waitMs = Number(env('COS_COORD_WAIT_MS', String(core.WAIT_MS)));
  const r = claimsStore.takeGitLock(claimsDir, kind, repo, { holderId: owner, holder: terminal }, { reason: op, ttlMs: core.GIT_TTL_MS, waitMs, boardDir: dir });
  if (r.ok) process.exit(0); // allow
  const who = r.holder ? r.holder.holder : 'another terminal';
  const reason = `Coordination: ${kind}:${repo.name} is held by ${who}. Wait a few seconds and retry the ${op}.`;
  denyJson(reason);
  process.exit(0);
}

// Which repository a git command acts on: its -C / `cd X &&` target (coord-core
// resolveTargetPath), else the cwd, named by its git common dir. Only when git cannot say — not a
// repo, an unexpanded `$d` — is it named the old way, by the target folder's name.
function repoOf(cc, core, command, cwd) {
  const path = require('path');
  const { spawnSync } = require('child_process');
  const target = core.resolveTargetPath(command, cwd);
  for (const where of [path.resolve(cwd, String(target)), cwd]) {
    const r = spawnSync('git', ['-C', where, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return cc.repoIdentity(r.stdout, where);
  }
  return cc.legacyRepoIdentity(core.baseName(target));
}

module.exports = { failurePolicyFor };

if (require.main === module) {
  try { main(); } catch {
    // Reached only by the Bash and Task modes (the write gate catches its own): fail-open.
    process.exit(0);
  }
}
