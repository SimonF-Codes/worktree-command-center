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

function gitResource(op, command, cwd) {
  const repo = baseName(resolveTargetPath(command, cwd));
  return (op === 'push' ? 'push:' : 'worktree:') + repo;
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

module.exports = {
  WAIT_MS, POLL_MS, CLI_TTL_MS, GIT_TTL_MS, TELL_WAIT_MS, SEP,
  slug, parseGitOp, baseName, resolveTargetPath, gitResource,
  lockStatus, formatBoardLine, parseBoardLine, mergeEvents, taskLabel,
  formatChatLine, parseChatLine,
};
