'use strict';
// cos-coord <status|acquire|release|note> — agents call this from Bash.
// Fail-open: unexpected errors exit 0 (allow). A timed-out acquire exits 1
// (the lock is working — the && chain should stop). tell/watch/spawn/rename/close/personality
// are GOD-only: called without COS_ROLE=god they exit 2 (a refusal is a failure, not a silent
// no-op). The same commands also exit 2 when called AS god but missing a required argument (empty
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
  try { file = store.newTab(dir, b.fields); } catch (e) { newTabFail(`could not write the request: ${e.message}`); }
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

function main() {
  const dir = env('COS_COORD_DIR');
  const terminal = env('COS_TERMINAL_NAME', `pid${process.pid}`);
  const holderId = Number(env('COS_TERMINAL_ID', String(process.pid)));
  if (process.argv[2] === 'new-tab') { try { return newTab(dir); } catch (e) { return newTabFail(`failed: ${e.message}`); } }
  if (!dir) { process.exit(0); } // coordination not configured → allow
  const [cmd, resource, ...rest] = process.argv.slice(2);

  if (cmd === 'status') {
    const now = Date.now();
    const locks = store.readLocks(dir);
    if (!locks.length) console.log('coord: no active locks');
    for (const l of locks) {
      const st = core.lockStatus(l, now);
      console.log(`coord: ${l.resource} — ${l.holder}${l.reason ? ` (${l.reason})` : ''} · ${ageStr(now - l.ts)}${st === 'stale' ? ' [stale]' : ''}`);
    }
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
    if (env('COS_ROLE') !== 'god') denyGodOnly('tell'); // only GOD may inject into worker terminals
    const target = resource;
    const message = rest.join(' ');
    requireArgs('tell', Boolean(target && message), '<target> "<message>"');
    const file = store.tell(dir, target, message);
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
    store.watch(dir, target, note);
    process.exit(0);
  }

  if (cmd === 'spawn') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('spawn');
    const repo = resource;
    const base = flag(rest, '--base') || '';
    const task = flag(rest, '--task') || '';
    const model = flag(rest, '--model') || '';
    const effort = flag(rest, '--effort') || '';
    const name = flag(rest, '--name') || '';
    requireArgs('spawn', Boolean(repo && task), '<repo> --task "<task>"');
    store.spawn(dir, repo, base, task, model, effort, name);
    process.exit(0);
  }

  if (cmd === 'rename') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('rename'); // only GOD may rename worker terminals
    const target = resource;
    const to = flag(rest, '--to') || '';
    requireArgs('rename', Boolean(target && to.trim()), '<target> --to "<name>"');
    store.rename(dir, target, to);
    process.exit(0);
  }

  if (cmd === 'close') {
    if (env('COS_ROLE') !== 'god') denyGodOnly('close'); // only GOD may end a worker's session
    const target = resource;
    requireArgs('close', Boolean(target && target.trim()), '<target>');
    const file = store.close(dir, target);
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
    store.personality(dir);
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

  console.error('usage: cos-coord <status|acquire|release|note|chat|tell|watch|spawn|rename|close|personality|new-tab> [resource] [--reason "…"] [--ttl <sec>] [--note "…"] [--base <branch>] [--task "…"] [--model <model>] [--effort <level>] [--name "…"] [--to "…"]');
  process.exit(0);
}

try { main(); } catch (e) { try { console.error('coord: ' + e.message); } catch (_) {} process.exit(0); }
