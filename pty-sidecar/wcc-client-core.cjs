'use strict';
// Pure helpers for wcc-client — the client for the CONNECTOR channel (see docs/api.md). No IO
// here: argument parsing, envelope building, receipt interpretation and roster formatting, so
// tests/wcc-client.test.ts can check every one of them against the app's own parser
// (src/terminals/connectors.ts) and state builder (src/terminals/floor-state.ts).
//
// This is deliberately NOT cos-coord. cos-coord is the overseer's privileged channel
// (god-outbox/); this client only ever writes into connectors/<id>/requests/, so it carries
// connector authority — spawn and tell — and nothing more.

const APP_DIR_NAME = 'worktree-command-center';
const DEFAULT_WAIT_MS = 60000;
const POLL_MS = 150;

// Exit codes. 2 = definitely did not happen (rejected, withdrawn, bad usage); 3 = the app took the
// request but never confirmed within the wait — it may still land, so a script must not blindly
// retry a spawn on 3.
const EXIT_OK = 0;
const EXIT_FAILED = 2;
const EXIT_UNCONFIRMED = 3;

// Flags that take a value. Anything else starting with `--` is a boolean switch.
const VALUE_FLAGS = new Set(['--coord-dir', '--workspace', '--connector', '--wait-ms', '--task', '--base', '--model', '--effort', '--name']);
const BOOL_FLAGS = new Set(['--json', '--help']);

/** Split argv into a command, positionals and flags. Unknown flags are an error rather than
 *  being silently ignored — a misspelt `--efort high` must not spawn at the default effort. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; } // the rest is literal, e.g. a message starting with "--"
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        if (i + 1 >= argv.length) return { ok: false, reason: `${a} needs a value` };
        flags[a.slice(2)] = argv[++i];
      } else if (BOOL_FLAGS.has(a)) {
        flags[a.slice(2)] = true;
      } else {
        return { ok: false, reason: `unknown flag ${a}` };
      }
      continue;
    }
    positional.push(a);
  }
  const [command, ...args] = positional;
  return { ok: true, command: command || null, args, flags };
}

/** The app's userData folder, which is where Electron keeps it for an app named
 *  `worktree-command-center` on each platform. `WCC_USER_DATA` overrides it. */
function defaultUserData(env, platform, home) {
  if (env.WCC_USER_DATA) return env.WCC_USER_DATA;
  if (platform === 'win32') return joinPath(platform, env.APPDATA || joinPath(platform, home, 'AppData', 'Roaming'), APP_DIR_NAME);
  if (platform === 'darwin') return joinPath(platform, home, 'Library', 'Application Support', APP_DIR_NAME);
  return joinPath(platform, env.XDG_CONFIG_HOME || joinPath(platform, home, '.config'), APP_DIR_NAME);
}

function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts.map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
}

/** Which workspace's coordination directory to talk to. An explicit directory wins (flag, then
 *  env); otherwise a workspace id (flag, then env) under the default userData. There is no
 *  silent default workspace: talking to the wrong floor is worse than being told to pick one. */
function resolveCoordDir(flags, env, platform, home) {
  const dir = flags['coord-dir'] || env.WCC_COORD_DIR;
  if (dir) return { ok: true, dir };
  const ws = flags.workspace || env.WCC_WORKSPACE;
  if (ws) return { ok: true, dir: joinPath(platform, defaultUserData(env, platform, home), '.coordination', ws) };
  return { ok: false, reason: 'no coordination directory — pass --coord-dir <dir> or --workspace <id> (or set WCC_COORD_DIR / WCC_WORKSPACE)' };
}

function resolveConnector(flags, env) {
  const id = flags.connector || env.WCC_CONNECTOR;
  if (!id) return { ok: false, reason: 'no connector id — pass --connector <id> or set WCC_CONNECTOR (it must be registered in the app\'s config.json "connectors" list)' };
  if (!/^[a-z0-9-]+$/.test(id)) return { ok: false, reason: `connector id "${id}" is not a slug — lowercase letters, digits and "-" only` };
  return { ok: true, id };
}

function resolveWaitMs(flags, env) {
  const raw = flags['wait-ms'] != null ? flags['wait-ms'] : env.WCC_WAIT_MS;
  if (raw == null || raw === '') return DEFAULT_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

/** A v1 spawn envelope. Optional fields are sent as null rather than omitted, matching the
 *  documented envelope field for field. */
function buildSpawnRequest({ id, connector, sentMs, repo, task, base, model, effort, name }) {
  return { v: 1, id, connector, sentMs, kind: 'spawn', repo, base: base || null, task, model: model || null, effort: effort || null, name: name || null };
}

function buildTellRequest({ id, connector, sentMs, terminal, message }) {
  return { v: 1, id, connector, sentMs, kind: 'tell', terminal, message };
}

/** The same sanitisation as connectors.ts's receiptFilename — the app names the receipt with it,
 *  so the client must look for exactly that name. */
function receiptFilename(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe || '_'}.json`;
}

/** Turn a receipt into an outcome. Anything that isn't a well-formed `accepted` is a failure. */
function interpretReceipt(r) {
  if (r && r.status === 'accepted') return { ok: true, terminalName: typeof r.terminalName === 'string' ? r.terminalName : null };
  const reason = r && typeof r.reason === 'string' && r.reason ? r.reason : 'rejected without a reason (malformed receipt)';
  return { ok: false, reason };
}

/** Floor state older than this many feed intervals is reported as stale: the app has stopped
 *  rewriting it (quit, or no overseer console open in that workspace). */
const STALE_INTERVALS = 3;

function stateAgeMs(state, now) { return Math.max(0, now - (Number(state && state.ts) || 0)); }

function isStale(state, now) {
  const interval = Number(state && state.intervalMs) || 4000;
  return stateAgeMs(state, now) > interval * STALE_INTERVALS;
}

function ageStr(ms) { const s = Math.round(ms / 1000); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; }

/** The roster as a plain table: one line per session. */
function formatFloor(state, now) {
  const lines = [`floor ${state.workspaceId} — snapshot ${ageStr(stateAgeMs(state, now))} old`];
  const terms = Array.isArray(state.terminals) ? state.terminals : [];
  if (!terms.length) lines.push('  (no sessions open)');
  for (const t of terms) {
    const where = t.kind === 'terminal' ? `${t.repo} · ${t.branch}` : t.kind;
    const status = t.busy === true ? 'busy' : t.busy === false ? 'idle' : '-';
    const tags = [t.hidden ? 'hidden' : '', t.tellable ? '' : 'not tellable'].filter(Boolean).join(', ');
    lines.push(`  ${t.name}  ${where}  ${status}${tags ? `  (${tags})` : ''}`);
  }
  return lines.join('\n');
}

const USAGE = [
  'wcc-client — talk to a Worktree Command Center floor through the connector channel.',
  '',
  'Usage:',
  '  wcc-client floor [--json]',
  '  wcc-client spawn <repo> --task "<task>" [--base <branch>] [--model <m>] [--effort <e>] [--name <n>]',
  '  wcc-client tell <terminal> "<message>"',
  '',
  'Where:   --coord-dir <dir> | WCC_COORD_DIR,  or  --workspace <id> | WCC_WORKSPACE',
  'Who:     --connector <id> | WCC_CONNECTOR   (registered in config.json "connectors"; spawn/tell only)',
  'Wait:    --wait-ms <ms> | WCC_WAIT_MS        (default 60000)',
  '',
  'spawn/tell block until the app writes a receipt. Exit 0 accepted (prints the terminal name);',
  '2 rejected or never picked up (reason on stderr); 3 picked up but not confirmed in time.',
  'Reference: docs/api.md',
].join('\n');

module.exports = {
  APP_DIR_NAME, DEFAULT_WAIT_MS, POLL_MS, EXIT_OK, EXIT_FAILED, EXIT_UNCONFIRMED, STALE_INTERVALS, USAGE,
  parseArgs, defaultUserData, resolveCoordDir, resolveConnector, resolveWaitMs,
  buildSpawnRequest, buildTellRequest, receiptFilename, interpretReceipt, isStale, stateAgeMs, formatFloor,
};
