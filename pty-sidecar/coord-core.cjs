'use strict';
// Pure coordination logic — no IO. Shared by coord-store/coord-cli/coord-hook,
// and mirrored in src/terminals/coordination.ts (kept honest by a drift test).

const WAIT_MS = 20000;              // default acquire poll window
const POLL_MS = 500;                // poll interval while waiting
const CLI_TTL_MS = 30 * 60 * 1000;  // default lifetime for explicit CLI locks
const GIT_TTL_MS = 10 * 60 * 1000;  // default lifetime for auto git locks
// How long `cos-coord tell` blocks for the app's delivery receipt before giving up and
// reporting failure itself. Must exceed the app's own give-up bound (terminals-grid.ts'
// TELL_MAX_WAIT_MS) so a slow-but-eventually-successful delivery gets an honest "accepted"
// receipt instead of the CLI's generic 'timeout' fallback.
const TELL_WAIT_MS = 45000;
const SEP = '\t';

function slug(resource) {
  return String(resource).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function parseGitOp(command) {
  const c = String(command);
  if (/\bgit\b[^\n]*\bworktree\s+add\b/.test(c)) return 'worktree-add';
  if (/\bgit\b[^\n]*\bpush\b/.test(c)) return 'push';
  return null;
}

function baseName(p) {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function resolveTargetPath(command, cwd) {
  const c = String(command);
  let m = c.match(/-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (m) return m[1] || m[2] || m[3];
  m = c.match(/(?:^|[;&|])\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/);
  if (m) return m[1] || m[2] || m[3];
  return cwd;
}

// Could the target a git command was parsed to act on be a real path? The hook reads the TEXT of a
// Bash command, so a session that merely writes about `git -C <repo> worktree add …` — in a
// heredoc, a fixture, a doc example — looks like a git operation on the folder "<repo>". Angle
// brackets are the placeholder signature and are never valid in a Windows path; an empty target is
// never valid anywhere. Deliberately narrow: this does not ask whether the path exists on disk.
function isPlausibleTarget(target) {
  const t = String(target == null ? '' : target).trim();
  return t !== '' && !/[<>]/.test(t);
}

// null when the target is not a plausible path: there is no real git operation to lock.
function gitResource(op, command, cwd) {
  const target = resolveTargetPath(command, cwd);
  if (!isPlausibleTarget(target)) return null;
  return (op === 'push' ? 'push:' : 'worktree:') + baseName(target);
}

function lockStatus(holder, now) {
  if (!holder) return 'free';
  const ttl = typeof holder.ttlMs === 'number' ? holder.ttlMs : CLI_TTL_MS;
  return now > holder.ts + ttl ? 'stale' : 'held';
}

function formatBoardLine(e) {
  const detail = String(e.detail == null ? '' : e.detail).replace(/[\t\r\n]+/g, ' ');
  return [e.ts, e.terminal, e.resource, e.status, detail].join(SEP) + '\n';
}

function parseBoardLine(line) {
  const raw = String(line).replace(/\r?\n$/, '');
  if (!raw.trim()) return null;
  const p = raw.split(SEP);
  if (p.length >= 5 && /^\d+$/.test(p[0]) && /^(START|DONE|NOTE)$/.test(p[3])) {
    return { ts: Number(p[0]), terminal: p[1], resource: p[2], status: p[3], detail: p.slice(4).join(SEP) };
  }
  return { raw };
}

function mergeEvents(events) {
  return events.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// Short human label for a Task/Agent tool call, used on background-task board events.
function taskLabel(toolInput) {
  const ti = toolInput || {};
  const d = String(ti.description || '').trim();
  if (d) return d.slice(0, 80);
  const p = String(ti.prompt || '').trim().replace(/\s+/g, ' ');
  if (p) return p.length > 80 ? p.slice(0, 80) + '…' : p;
  return String(ti.subagent_type || 'task');
}

function formatChatLine(e) {
  const msg = String(e.message == null ? '' : e.message).replace(/[\t\r\n]+/g, ' ');
  return [e.ts, e.terminal, msg].join(SEP) + '\n';
}

function parseChatLine(line) {
  const raw = String(line).replace(/\r?\n$/, '');
  if (!raw.trim()) return null;
  const p = raw.split(SEP);
  if (p.length >= 3 && /^\d+$/.test(p[0])) {
    return { ts: Number(p[0]), terminal: p[1], message: p.slice(2).join(SEP) };
  }
  return { raw };
}

// `cos-coord spawn`'s exit: what a receipt (or its absence) means for the caller. A spawn used to
// print nothing and exit 0 whether or not the app took it, so a caller could not tell accepted
// from dropped and spawned a duplicate. r is waitForTellReceipt's result; withdrawn says whether a
// timed-out request was taken back before the app claimed it (so it can never run late).
// Exit codes match new-tab's: 0 spawned, 2 refused or withdrawn (known not to have happened),
// 3 the app took it but never answered (it may still appear).
function spawnOutcome(r, opts = {}) {
  const repo = opts.repo || '?';
  const secs = Math.round((opts.waitMs || 0) / 1000);
  if (r && r.timedOut) {
    if (opts.withdrawn) return { code: 2, err: `coord: spawn in "${repo}" was WITHDRAWN — the app never picked it up within ${secs}s, so nothing was spawned and nothing will be. Is the app running?` };
    return { code: 3, err: `coord: spawn in "${repo}" was NOT confirmed — the app took it but gave no answer within ${secs}s; it may still appear. Check floor/INDEX.md before retrying` };
  }
  if (r && r.ok && r.spawned) {
    const s = r.spawned;
    // mode: the isolation decision (V2 step 8). A shared-readonly / scratch session has no branch
    // either, but it is not a folder target — say which it is.
    const where = s.branch ? `on ${s.branch}` : (s.mode && s.mode !== 'worktree' ? `(${s.mode} — no branch)` : '(folder — no branch)');
    return { code: 0, out: `coord: spawned "${s.terminal}" ${where} — session ${s.sessionId}` };
  }
  return { code: 2, err: `coord: spawn in "${repo}" did NOT happen — ${(r && r.reason) || 'unknown reason'}` };
}

// A session-channel request's exit (V2 step 10): what its receipt — `{ status: 'accepted' |
// 'rejected', reason, terminalName, spawned, proposalId }`, written by src/terminals/session-
// channel.ts — or its absence means for the caller. Same exit codes as spawnOutcome: 0 done, 2
// refused or withdrawn (known not to have happened), 3 taken but unanswered (it may still happen).
function sessionOutcome(kind, r, opts = {}) {
  const what = opts.what || kind;
  const secs = Math.round((opts.waitMs || 0) / 1000);
  if (r && r.timedOut) {
    if (opts.withdrawn) return { code: 2, err: `coord: ${what} was WITHDRAWN — the app never picked it up within ${secs}s, so nothing happened and nothing will. Is the app running?` };
    return { code: 3, err: `coord: ${what} was NOT confirmed — the app took it but gave no answer within ${secs}s; it may still happen. Check floor/INDEX.md before retrying` };
  }
  if (!r || r.status !== 'accepted') return { code: 2, err: `coord: ${what} did NOT happen — ${(r && r.reason) || 'unknown reason'}` };
  if (r.spawned) {
    const s = r.spawned;
    const where = s.branch ? `on ${s.branch}` : (s.mode && s.mode !== 'worktree' ? `(${s.mode} — no branch)` : '(folder — no branch)');
    const prop = r.proposalId ? ` (proposal ${r.proposalId} accepted)` : '';
    return { code: 0, out: `coord: spawned "${s.terminal}" ${where} — session ${s.sessionId}${prop}` };
  }
  if (kind === 'tell') return { code: 0, out: `coord: delivered to "${r.terminalName || '?'}"` };
  if (kind === 'assign') return { code: 0, out: `coord: "${r.terminalName || '?'}" now reports to this session` };
  if (kind === 'propose-spawn') return { code: 0, out: `coord: proposal ${r.proposalId || '?'} recorded — inert until a session that holds spawns: acts on it. \`cos-coord proposals\` shows its state` };
  if (kind === 'proposal-decline') return { code: 0, out: `coord: proposal ${r.proposalId || '?'} declined — the proposer can read why with \`cos-coord proposals\`` };
  return { code: 0, out: `coord: ${what} done` };
}

module.exports = {
  WAIT_MS, POLL_MS, CLI_TTL_MS, GIT_TTL_MS, TELL_WAIT_MS, SEP, spawnOutcome, sessionOutcome,
  slug, parseGitOp, baseName, resolveTargetPath, isPlausibleTarget, gitResource,
  lockStatus, formatBoardLine, parseBoardLine, mergeEvents, taskLabel,
  formatChatLine, parseChatLine,
};
