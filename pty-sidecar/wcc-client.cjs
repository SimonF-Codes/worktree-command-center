'use strict';
// wcc-client <floor|spawn|tell> — the client for the connector channel, for a process OUTSIDE
// the app (a plain `claude` session in some other directory, a script, another app). Thin IO
// over wcc-client-core.cjs; the reference is docs/api.md.
//
// It writes only into <coordDir>/connectors/<id>/requests/ and reads only the matching
// receipts/ and floor/state.json. It never touches god-outbox/ — that is the overseer's channel,
// and writing there from outside would be impersonating Kane, not requesting work.
//
// spawn/tell BLOCK on the receipt, the way `cos-coord tell` does: a request file on disk is proof
// it was written, never proof anything happened. When the wait runs out with the request still
// unread, the client withdraws it (an unlink that races the app's own rename, so exactly one of
// them wins) — a spawn must not fire hours later when the app is next started.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('./wcc-client-core.cjs');

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(reason, code = core.EXIT_FAILED) {
  console.error(`wcc-client: ${reason}`);
  process.exit(code);
}

function need(r) { if (!r.ok) fail(r.reason); return r; }

function floor(coordDir, flags) {
  const file = path.join(coordDir, 'floor', 'state.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    fail(`no floor state at ${file} — the app writes it while that workspace has an overseer console open; check the workspace id`);
  }
  let state;
  try { state = JSON.parse(text); } catch { fail(`${file} is not valid JSON`); }
  if (state.v !== 1) fail(`${file} is version ${state.v}; this client reads version 1`);
  const now = Date.now();
  if (core.isStale(state, now)) {
    console.error(`wcc-client: warning — floor state is ${Math.round(core.stateAgeMs(state, now) / 1000)}s old; the app is not refreshing it (closed, or no overseer console open in this workspace)`);
  }
  console.log(flags.json ? JSON.stringify(state, null, 2) : core.formatFloor(state, now));
  process.exit(core.EXIT_OK);
}

/** Drop one request atomically (temp file, then rename), then block on its receipt. */
function send(coordDir, connector, body, waitMs) {
  const base = path.join(coordDir, 'connectors', connector);
  const reqDir = path.join(base, 'requests');
  const receipt = path.join(base, 'receipts', core.receiptFilename(body.id));
  try { fs.mkdirSync(reqDir, { recursive: true }); } catch (e) { fail(`cannot create ${reqDir}: ${e.message}`); }
  const finalPath = path.join(reqDir, `${body.id}.json`);
  const tmp = path.join(reqDir, `.${body.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  fs.renameSync(tmp, finalPath);

  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      try { fs.unlinkSync(receipt); } catch { /* receipts are ours to clean up; best effort */ }
      return core.interpretReceipt(r);
    } catch { /* not written yet (or mid-rename) — keep polling */ }
    if (Date.now() >= deadline) break;
    sleepSync(core.POLL_MS);
  }
  // Out of time. If the request is still where we left it, the app never read it: withdraw it so
  // nothing happens later. If the unlink fails, the app's drain renamed it first — it was taken.
  try {
    fs.unlinkSync(finalPath);
    return { ok: false, code: core.EXIT_FAILED, reason: `the app never picked up request ${body.id} within ${Math.round(waitMs / 1000)}s — withdrawn, nothing will happen. Is the app running, and is ${coordDir} the right workspace?` };
  } catch {
    return { ok: false, code: core.EXIT_UNCONFIRMED, reason: `the app took request ${body.id} but gave no receipt within ${Math.round(waitMs / 1000)}s — it may still happen; check the floor before retrying` };
  }
}

function report(kind, r) {
  if (r.ok) { console.log(r.terminalName || ''); process.exit(core.EXIT_OK); }
  fail(`${kind} ${r.code === core.EXIT_UNCONFIRMED ? 'NOT confirmed' : 'rejected'} — ${r.reason}`, r.code || core.EXIT_FAILED);
}

function main() {
  const parsed = core.parseArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(`wcc-client: ${parsed.reason}\n\n${core.USAGE}`); process.exit(core.EXIT_FAILED); }
  const { command, args, flags } = parsed;
  if (flags.help || !command || command === 'help') { console.log(core.USAGE); process.exit(command || flags.help ? core.EXIT_OK : core.EXIT_FAILED); }

  const coordDir = need(core.resolveCoordDir(flags, process.env, process.platform, os.homedir())).dir;
  if (command === 'floor') return floor(coordDir, flags);

  if (command !== 'spawn' && command !== 'tell') fail(`unknown command "${command}" — floor, spawn or tell`);
  const connector = need(core.resolveConnector(flags, process.env)).id;
  const waitMs = core.resolveWaitMs(flags, process.env);
  const envelope = { id: crypto.randomUUID(), connector, sentMs: Date.now() };

  if (command === 'spawn') {
    const repo = args[0];
    if (!repo || !flags.task) fail('spawn needs <repo> --task "<task>"');
    const body = core.buildSpawnRequest({ ...envelope, repo, task: flags.task, base: flags.base, model: flags.model, effort: flags.effort, name: flags.name });
    return report('spawn', send(coordDir, connector, body, waitMs));
  }
  const [terminal, ...words] = args;
  const message = words.join(' ');
  if (!terminal || !message) fail('tell needs <terminal> "<message>"');
  return report('tell', send(coordDir, connector, core.buildTellRequest({ ...envelope, terminal, message }), waitMs));
}

main();
