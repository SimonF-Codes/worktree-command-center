'use strict';
// cos-coord <status|acquire|release|note|workstream|…> — agents call this from Bash.
// Fail-open: unexpected errors exit 0 (allow). A timed-out acquire exits 1
// (the lock is working — the && chain should stop). watch/rename/close/personality/new-tab
// are GOD-only: called without COS_ROLE=god they exit 2 (a refusal is a failure, not a silent
// no-op). spawn and tell from any OTHER session the app opened go through that session's own
// request directory (V2 step 10), as do assign and the spawn-proposal verbs; the app checks them
// against the role files and every one gets a receipt (docs/api.md, "Session requests"). The same commands also exit 2 when called AS god but missing a required argument (empty
// target/message/task/etc.) — a malformed handoff must fail loud too, not just an unauthorized one.
// `tell` additionally BLOCKS for the app's delivery receipt before reporting success (see
// store.waitForTellReceipt) — dropping the outbox file was never proof the message was typed
// into anything, let alone submitted. `close` blocks the same way: it exits 0 only once the app
// says the session actually ended, and 2 with the app's reason when it refused.
// `new-tab` (also GOD-only) blocks too, and is the one command that never fails open: it exits 0
// only on the app's word, 2 when refused or WITHDRAWN (nobody drained it in time, so it was taken
// back and will never run), 3 when the app took it but did not answer, 4 when it failed but left
// a repo folder behind. Reference: docs/api.md, "new-tab".
const path = require('path');
const core = require('./coord-core.cjs');
const store = require('./coord-store.cjs');
const newTabCore = require('./new-tab-core.cjs');

function env(name, dflt) { return process.env[name] != null ? process.env[name] : dflt; }
function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function ageStr(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`; }

// A refused privileged command is a FAILURE, not a no-op success: exit 2 + say why on stderr, so
// a caller checking the exit code (a shell `&&` chain, a script) finds out instead of silently
// getting nothing. The command still does nothing else — this only changes how the refusal reports.
function denyGodOnly(cmd) {
  console.error(`coord: ${cmd} requires COS_ROLE=god — refused`);
  process.exit(2);
}

// Same idea, one level down: the caller had permission but left out a required argument
// (e.g. `tell "Foo"` with no message). Silently doing nothing here is exactly as misleading
// as the role-gate case, so it gets the same treatment: exit 2 + say what's missing.
function requireArgs(cmd, ok, usage) {
  if (ok) return;
  console.error(`coord: ${cmd} requires ${usage}`);
  process.exit(2);
}

// A session-channel verb needs the session's own directory to drop into. Which directory is a
// routing choice, never an authority check: the APP decides what the session may do, from its
// record and its role file (src/core/session-requests.ts) — so no COS_* value grants anything here.
function requireSessionId(cmd) {
  const me = env('COS_SESSION_ID', '');
  if (store.SESSION_ID.test(me)) return me;
  console.error(`coord: ${cmd} requires COS_ROLE=god, or a session the app opened (COS_SESSION_ID) to send it through its own request directory — refused`);
  process.exit(2);
}

// Drop one request into this session's directory and block for the app's receipt. Not fail-open:
// the request either happened or it did not, and the exit code says which (core.sessionOutcome).
function viaSession(dir, kind, body, what, waitEnv) {
  const me = requireSessionId(kind);
  let file;
  // The rest of this file fails OPEN on an unexpected error; a request must not, or a drop that
  // never happened would exit 0.
  try { file = store.dropSessionRequest(dir, me, { kind, ...body }); } catch (e) { console.error(`coord: ${what} did NOT happen — could not write the request: ${e.message}`); process.exit(2); }
  const id = path.basename(file, '.json');
  const waitMs = Number(env(waitEnv, String(core.TELL_WAIT_MS)));
  const r = store.waitForReceiptFile(store.sessionReceiptPath(dir, me, id), { waitMs });
  const o = core.sessionOutcome(kind, r, { what, waitMs, withdrawn: r.timedOut ? store.withdraw(file) : false });
  if (o.out) console.log(o.out);
  if (o.err) console.error(o.err);
  process.exit(o.code);
}

// One line per write lease in the machine-wide store (lenient read: this is a display).
function leaseLines(claimsDir, now) {
  const claimsStore = require('./claims-store.cjs');
  const me = env('COS_SESSION_ID', '');
  return claimsStore.readClaims(claimsDir).map((c) => {
    const st = core.lockStatus(c, now);
    return `coord: write lease ${c.path} — ${c.holder} (${c.mode || 'shared-write'}) · ${ageStr(now - c.ts)}${st === 'stale' ? ' [stale]' : ''}${me && c.sessionId === me ? ' [yours]' : ''}`;
  });
}

function newTabFail(reason, code = 2) {
  console.error(`coord: new-tab ${reason}`);
  process.exit(code);
}

// Kane opens a workspace tab bound to a repo. Not fail-open like the rest of this file: a tab
// and a repo either happened or they did not, and the exit code must say which.
function newTab(dir) {
  if (env('COS_ROLE') !== 'god') denyGodOnly('new-tab');
  if (!dir) newTabFail('needs COS_COORD_DIR — run it from a session the app opened');
  const p = newTabCore.parseNewTabArgv(process.argv.slice(3));
  if (!p.ok) newTabFail(p.reason);
  const b = newTabCore.buildNewTabFields(p.name, p.flags, (x) => path.resolve(x));
  if (!b.ok) newTabFail(b.reason);
  let file;
  try { file = store.newTab(dir, b.fields, env('COS_SESSION_ID', '')); } catch (e) { newTabFail(`could not write the request: ${e.message}`); }
  const id = path.basename(file, '.json');
  const waitMs = Number(env('COS_COORD_NEW_TAB_WAIT_MS', String(newTabCore.NEW_TAB_WAIT_MS)));
  const r = store.waitForTellReceipt(dir, id, { waitMs });
  if (r.timedOut) {
    if (store.withdraw(file)) newTabFail(`was WITHDRAWN — the app never picked it up within ${Math.round(waitMs / 1000)}s, so nothing was created and nothing will be. Is the app running?`);
    newTabFail(`was NOT confirmed — the app took it but gave no answer within ${Math.round(waitMs / 1000)}s; it may still happen. Check the tab bar before retrying`, 3);
  }
  const out = newTabCore.interpretNewTabReceipt(r);
  if (!out.ok) {
    if (out.leftOnDisk) newTabFail(`failed, and LEFT A REPO ON DISK at ${out.leftOnDisk} — ${out.reason}`, newTabCore.EXIT_LEFT_ON_DISK);
    newTabFail(`refused — ${out.reason}`);
  }
  console.log(p.flags.json ? JSON.stringify(out.result, null, 2) : out.result.workspaceId);
  console.error(newTabCore.formatNewTabResult(out.result));
  process.exit(0);
}

// Not fail-open: a release either happened or it did not, and the exit code says which.
function lease(dir, resource) {
  const claimsStore = require('./claims-store.cjs');
  const cc = require('./claims-core.cjs');
  const claimsDir = env('COS_CLAIMS_DIR') || (dir ? claimsStore.claimsDirOf(dir) : '');
  if (!claimsDir) { console.error('coord: lease needs COS_CLAIMS_DIR or COS_COORD_DIR — run it from a session the app opened'); process.exit(2); }
  if (resource !== 'release') {
    const lines = leaseLines(claimsDir, Date.now());
    console.log(lines.length ? lines.join('\n') : 'coord: no write leases');
    process.exit(0);
  }
  const sessionId = env('COS_SESSION_ID', '');
  const checkout = env('COS_CHECKOUT', '');
  if (!sessionId || !checkout) { console.error('coord: lease release needs a shared session the app opened (COS_SESSION_ID and COS_CHECKOUT)'); process.exit(2); }
  const held = claimsStore.claimsOf(claimsDir, sessionId).find((c) => cc.checkoutId(c.path) === cc.checkoutId(checkout));
  if (!held) { console.error(`coord: this session holds no write lease on ${checkout} — nothing released`); process.exit(2); }
  const st = require('child_process').spawnSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8', timeout: 15000 });
  const refusal = cc.releaseRefusal(st.status === 0 ? st.stdout : null, checkout);
  if (refusal) { console.error(`coord: lease release refused — ${refusal}`); process.exit(2); }
  if (!claimsStore.releaseClaim(claimsDir, checkout, sessionId, { boardDir: dir })) { console.error(`coord: the lease on ${checkout} changed hands before it could be released`); process.exit(2); }
  console.log(`coord: released the write lease on ${checkout}`);
  process.exit(0);
}

// `cos-coord workstream …` — append one event to <coordDir>/workstreams.jsonl (or list them). The
// read, the plan and the append happen under the store's guard, so two concurrent `open`s cannot
// both mint ws-4: ids are numbered from what is on disk at the moment of writing.
function workstream(dir, argv) {
  const fs = require('fs');
  const wsCore = require('./workstreams-core.cjs');
  const i = argv.indexOf('--dir');
  if (i >= 0) { dir = argv[i + 1]; argv = [...argv.slice(0, i), ...argv.slice(i + 2)]; }
  if (!dir) { console.error('coord: workstream needs COS_COORD_DIR (run it from a session the app opened) or --dir <coordination dir>'); process.exit(2); }
  const file = path.join(dir, 'workstreams.jsonl');
  const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  if (argv[0] === 'list') {
    const now = Date.now();
    const all = wsCore.foldWorkstreams(read());
    const shown = argv.includes('--all') ? all : all.filter((w) => w.state === 'open');
    if (argv.includes('--json')) { console.log(JSON.stringify(shown, null, 2)); process.exit(0); }
    console.log(shown.length ? shown.map((w) => wsCore.formatWorkstream(w, now)).join('\n') : `coord: no ${argv.includes('--all') ? '' : 'open '}workstreams in this workspace`);
    process.exit(0);
  }
  const actor = env('COS_SESSION_ID', '') || env('COS_TERMINAL_NAME', '') || null;
  fs.mkdirSync(dir, { recursive: true });
  const r = store.withGuard(file, () => {
    const p = wsCore.planWorkstreamCommand(argv, wsCore.foldWorkstreams(read()), actor, Date.now());
    if (p.ok) fs.appendFileSync(file, JSON.stringify(p.event) + '\n', 'utf8');
    return p;
  });
  if (!r.ok) { console.error(`coord: workstream refused — ${r.reason}`); process.exit(2); }
  console.log(`coord: ${r.say}`);
  process.exit(0);
}

function main() {
  const dir = env('COS_COORD_DIR');
  const terminal = env('COS_TERMINAL_NAME', `pid${process.pid}`);
  const holderId = Number(env('COS_TERMINAL_ID', String(process.pid)));
  // Who is asking, for the outbox's `from`. Set by the app per spawn path; attribution only.
  const from = env('COS_SESSION_ID', '');
  if (process.argv[2] === 'new-tab') { try { return newTab(dir); } catch (e) { return newTabFail(`failed: ${e.message}`); } }
  // `cos-coord lease` lists the machine-wide write leases; `cos-coord lease release` gives up this
  // session's lease on its checkout — refused (exit 2) unless the checkout is clean, and refused
  // loudly when this session holds none: a release that silently did nothing is B3 again. Before
  // the fail-open exit below, for the same reason.
  if (process.argv[2] === 'lease') {
    try { return lease(dir, process.argv[3]); } catch (e) { console.error(`coord: lease ${process.argv[3] || ''} failed — ${e.message}`); process.exit(2); }
  }
  // Workstreams and their tasks (V2 step 11). The CLI owns workstreams.jsonl and the app only reads
  // it. Not fail-open, for the same reason as lease: a write either happened or it did not.
  if (process.argv[2] === 'workstream') {
    try { return workstream(dir, process.argv.slice(3)); } catch (e) { console.error(`coord: workstream failed — ${e.message}`); process.exit(2); }
  }
  if (!dir) { process.exit(0); } // coordination not configured → allow
  const [cmd, resource, ...rest] = process.argv.slice(2);

  if (cmd === 'status') {
    const now = Date.now();
    // This workspace's explicit locks, then the machine-wide ones every workspace shares: the
    // automatic git locks (Q12) and the write leases.
    const claimsDir = env('COS_CLAIMS_DIR') || require('./claims-store.cjs').claimsDirOf(dir);
    let gitLocks = [];
    try { gitLocks = require('./claims-store.cjs').readGitLocks(claimsDir); } catch { /* a display: lenient */ }
    const locks = [...store.readLocks(dir), ...gitLocks];
    if (!locks.length) console.log('coord: no active locks');
    for (const l of locks) {
      const st = core.lockStatus(l, now);
      console.log(`coord: ${l.resource} — ${l.holder}${l.reason ? ` (${l.reason})` : ''} · ${ageStr(now - l.ts)}${st === 'stale' ? ' [stale]' : ''}`);
    }
    try { for (const line of leaseLines(claimsDir, now)) console.log(line); } catch { /* a display: lenient */ }
    process.exit(0);
  }

  if (cmd === 'note') {
    store.note(dir, terminal, [resource, ...rest].filter(Boolean).join(' '));
    process.exit(0);
  }

  if (cmd === 'chat') {
    store.appendChat(dir, terminal, [resource, ...rest].filter(Boolean).join(' '));
    process.exit(0);
  }

  if (cmd === 'tell') {
    const target = resource;
    const message = rest.join(' ');
    // Not god: a manager's tell, through its own request directory. The app decides — it reaches
    // only the sender's own descendants (src/core/session-requests.ts).
    if (env('COS_ROLE') !== 'god') {
      requireSessionId('tell');
      requireArgs('tell', Boolean(target && message), '<target> "<message>"');
      return viaSession(dir, 'tell', { terminal: target, message }, `tell to "${target}"`, 'COS_COORD_TELL_WAIT_MS');
    }
    requireArgs('tell', Boolean(target && message), '<target> "<message>"');
    const file = store.tell(dir, target, message, from);
    const id = path.basename(file, '.json');
    const waitMs = Number(env('COS_COORD_TELL_WAIT_MS', String(core.TELL_WAIT_MS)));
    const r = store.waitForTellReceipt(dir, id, { waitMs });
    if (r.ok) { console.log(`coord: delivered to "${target}"`); process.exit(0); }
    console.error(`coord: tell to "${target}" was NOT delivered — ${r.reason || 'unknown reason'}`);
    process.exit(2);
  }

  if (cmd === 'watch') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('watch');
    const target = resource;
    const note = flag(rest, '--note') || '';
    requireArgs('watch', Boolean(target && note), '<target> --note "<note>"');
    store.watch(dir, target, note, from);
    process.exit(0);
  }

  if (cmd === 'spawn') {
    if (env('COS_ROLE') !== 'god') requireSessionId('spawn');
    const repo = resource;
    const base = flag(rest, '--base') || '';
    const task = flag(rest, '--task') || '';
    const model = flag(rest, '--model') || '';
    const effort = flag(rest, '--effort') || '';
    const name = flag(rest, '--name') || '';
    const workstream = flag(rest, '--workstream') || '';
    const role = flag(rest, '--role') || ''; // passed through; the app's role loader decides what it resolves to
    // Isolation intent (V2 step 8): passed through as given; the app's decideIsolation reads them,
    // and only under the `isolation: cheap-readonly` setting do they change anything.
    const taskClass = flag(rest, '--class') || '';
    const writes = flag(rest, '--writes') || '';
    const isolation = flag(rest, '--isolation') || '';
    requireArgs('spawn', Boolean(repo && task), '<repo> --task "<task>"');
    // Not god: a manager's spawn, through its own request directory. The app runs checkDelegation
    // against the two role files and refuses with the condition that failed.
    if (env('COS_ROLE') !== 'god') {
      return viaSession(dir, 'spawn', { repo, base: base || null, task, model: model || null, effort: effort || null, name: name || null, workstream: workstream || null, role: role || null, taskClass: taskClass || null, writes: writes || null, isolation: isolation || null }, `spawn in "${repo}"`, 'COS_COORD_SPAWN_WAIT_MS');
    }
    // Block for the app's receipt, the way tell does: success prints the terminal, its branch and
    // the sessionId it was given; anything else exits non-zero with the reason (core.spawnOutcome).
    const file = store.spawn(dir, repo, base, task, model, effort, name, { workstream, role, from, taskClass, writes, isolation });
    const id = path.basename(file, '.json');
    const waitMs = Number(env('COS_COORD_SPAWN_WAIT_MS', String(core.TELL_WAIT_MS)));
    const r = store.waitForTellReceipt(dir, id, { waitMs });
    const o = core.spawnOutcome(r, { repo, waitMs, withdrawn: r.timedOut ? store.withdraw(file) : false });
    if (o.out) console.log(o.out);
    if (o.err) console.error(o.err);
    process.exit(o.code);
  }

  if (cmd === 'assign') {
    requireSessionId('assign');
    requireArgs('assign', Boolean(resource && resource.trim()), '<terminal>');
    return viaSession(dir, 'assign', { terminal: resource }, `assign "${resource}"`, 'COS_COORD_TELL_WAIT_MS');
  }

  // Spawn proposals (V2 step 10). Any session may propose, whatever its rung; the record is inert
  // until a session whose role holds spawns: accepts it, and accepting re-runs checkDelegation.
  if (cmd === 'propose-spawn') {
    const all = [resource, ...rest].filter((x) => x !== undefined);
    const role = flag(all, '--role') || '';
    const task = flag(all, '--task') || '';
    const why = flag(all, '--why') || '';
    requireArgs('propose-spawn', Boolean(role && task && why), '--role <slug> --task "<task>" --why "<why it deserves its own session>"');
    return viaSession(dir, 'propose-spawn', { role, task, why }, 'propose-spawn', 'COS_COORD_TELL_WAIT_MS');
  }

  if (cmd === 'proposal') {
    const id = rest[0];
    if (resource === 'accept') {
      requireArgs('proposal accept', Boolean(id), '<proposal-id> [--repo <repo>] [--base <branch>]');
      return viaSession(dir, 'proposal-accept', { proposal: id, repo: flag(rest, '--repo') || null, base: flag(rest, '--base') || null }, `accept of proposal ${id}`, 'COS_COORD_SPAWN_WAIT_MS');
    }
    if (resource === 'decline') {
      const reason = flag(rest, '--reason') || '';
      requireArgs('proposal decline', Boolean(id && reason), '<proposal-id> --reason "<why not>"');
      return viaSession(dir, 'proposal-decline', { proposal: id, reason }, `decline of proposal ${id}`, 'COS_COORD_TELL_WAIT_MS');
    }
    requireArgs('proposal', false, 'accept <id> [--repo <repo>] | decline <id> --reason "…"');
  }

  // Read-only: this session's proposals (made by it, or addressed to it), or every one with --all.
  // Reads the append-only file directly, so a proposer can read a decline's reason with no app.
  if (cmd === 'proposals') {
    const proposalsCore = require('./proposals-core.cjs');
    let text = '';
    try { text = require('fs').readFileSync(path.join(dir, 'spawn-proposals.jsonl'), 'utf8'); } catch { /* none yet */ }
    const all = proposalsCore.foldProposals(text);
    const me = env('COS_SESSION_ID', '');
    const showAll = resource === '--all' || !me;
    const mine = showAll ? all : all.filter((p) => p.from.sessionId === me || p.to === me);
    const names = {};
    for (const p of all) names[p.from.sessionId] = p.from.name;
    if (me) names[me] = `${names[me] || me} (you)`;
    console.log(mine.length ? mine.map((p) => proposalsCore.formatProposal(p, names)).join('\n') : `coord: no spawn proposals${showAll ? '' : ' from or to this session'}`);
    process.exit(0);
  }

  if (cmd === 'rename') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('rename'); // only GOD may rename worker terminals
    const target = resource;
    const to = flag(rest, '--to') || '';
    requireArgs('rename', Boolean(target && to.trim()), '<target> --to "<name>"');
    store.rename(dir, target, to, from);
    process.exit(0);
  }

  if (cmd === 'close') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('close'); // only GOD may end a worker's session
    const target = resource;
    requireArgs('close', Boolean(target && target.trim()), '<target>');
    const file = store.close(dir, target, from);
    const id = path.basename(file, '.json');
    // Parking runs git status/add/commit first; its worst case (~38s) fits inside tell's window.
    const waitMs = Number(env('COS_COORD_CLOSE_WAIT_MS', String(core.TELL_WAIT_MS)));
    const r = store.waitForTellReceipt(dir, id, {
      waitMs,
      timeoutReason: 'the app never confirmed the close — it may still happen; check floor/INDEX.md before retrying',
    });
    if (r.ok) { console.log(`coord: ${r.message || `closed "${target}"`}`); process.exit(0); }
    // A refusal is known not to have happened; a timeout is only unconfirmed — say which.
    console.error(`coord: close "${target}" ${r.timedOut ? 'was NOT confirmed' : 'did NOT happen'} — ${r.reason || 'unknown reason'}`);
    process.exit(2);
  }

  if (cmd === 'personality') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('personality'); // only Kane toggles his own personality
    store.personality(dir, from);
    process.exit(0);
  }

  if (cmd === 'acquire') {
    const waitMs = Number(env('COS_COORD_WAIT_MS', String(core.WAIT_MS)));
    const ttlMs = flag(rest, '--ttl') ? Number(flag(rest, '--ttl')) * 1000 : core.CLI_TTL_MS;
    const reason = flag(rest, '--reason') || '';
    const r = store.acquire(dir, resource, { holderId, terminal }, { reason, ttlMs, waitMs });
    if (r.ok) { console.log(`coord: acquired ${resource}`); process.exit(0); }
    console.error(`coord: ${resource} held by ${r.holder ? r.holder.holder : '?'}${r.holder && r.holder.reason ? ` (${r.holder.reason})` : ''} — try again later`);
    process.exit(1);
  }

  if (cmd === 'release') {
    store.release(dir, resource, holderId);
    process.exit(0);
  }

  console.error('usage: cos-coord <status|lease [release]|workstream|acquire|release|note|chat|tell|watch|spawn|assign|propose-spawn|proposal accept|proposal decline|proposals|rename|close|personality|new-tab> [resource] [--reason "…"] [--ttl <sec>] [--note "…"] [--base <branch>] [--task "…"] [--model <model>] [--effort <level>] [--name "…"] [--workstream <id>] [--role <slug>] [--class <task-class>] [--writes <none|repo|outside>] [--isolation <mode>] [--to "…"] [--why "…"] [--repo <repo>] [--reason "…"]');
  process.exit(0);
}

try { main(); } catch (e) { try { console.error('coord: ' + e.message); } catch (_) {} process.exit(0); }
