'use strict';
// Workstreams, with their tasks inline (V2 Team Floor step 11, design §3 "Workstreams" and §D) —
// the pure fold and the pure command planner, shared by `cos-coord workstream …` (which writes the
// file) and the app + `wcc-team metrics` (which read it), so every reader gets one answer.
//
// `<coordDir>/workstreams.jsonl` is APPEND-ONLY (D2): persist() rewrites config.json and the
// sessions file from memory and would silently discard an outside edit, so CLI-writable state lives
// here instead, and a correction is a new line — never an edit. One line per event:
//
//   {"v":1,"ev":"open","ts":…,"id":"ws-3","title":"…","by":"<sessionId|name>","note":"…"?}
//   {"v":1,"ev":"assign","ts":…,"id":"ws-3","to":"<sessionId>"|null,"by":…}
//   {"v":1,"ev":"close","ts":…,"id":"ws-3","outcome":"landed"|"dropped","commit"?,"branch"?,"reason"?,"by":…}
//   {"v":1,"ev":"reopen","ts":…,"id":"ws-3","reason":"…","by":…}
//   {"v":1,"ev":"task","op":"add","ts":…,"id":"ws-3","task":"t1","title":"…","owner"?,"note"?,"by":…}
//   {"v":1,"ev":"task","op":"start"|"block"|"done"|"drop","ts":…,"id":"ws-3","task":"t1","reason"?,"by":…}
//
// A workstream CARRIES ITS TASKS rather than pointing at a sibling file: one unit of work, one
// place, and a workstream with no tasks behaves exactly as designed. Nothing here reads a clock,
// the filesystem or the environment — the CLI hands in `now` and the actor.

const TASK_STATES = ['todo', 'doing', 'blocked', 'done', 'dropped'];
const TASK_OPS = { start: 'doing', block: 'blocked', done: 'done', drop: 'dropped' };
const WS_ID = /^ws-(\d{1,9})$/;
const TASK_ID = /^t(\d{1,9})$/;

function str(v) { return typeof v === 'string' && v.trim() ? v : null; }
function num(re, s) { const m = re.exec(String(s)); return m ? Number(m[1]) : 0; }

// One line → an event, or null for anything unreadable (a torn last line, a hand edit).
function parseWorkstreamEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.ts !== 'number' || !WS_ID.test(String(o.id))) return null;
  const by = str(o.by);
  switch (o.ev) {
    case 'open':
      return str(o.title) ? { ev: 'open', ts: o.ts, id: o.id, title: o.title, by, note: str(o.note) } : null;
    case 'assign':
      return { ev: 'assign', ts: o.ts, id: o.id, to: str(o.to), by };
    case 'close':
      return o.outcome === 'landed' || o.outcome === 'dropped'
        ? { ev: 'close', ts: o.ts, id: o.id, outcome: o.outcome, commit: str(o.commit), branch: str(o.branch), reason: str(o.reason), by }
        : null;
    case 'reopen':
      return { ev: 'reopen', ts: o.ts, id: o.id, reason: str(o.reason), by };
    case 'task':
      if (!TASK_ID.test(String(o.task))) return null;
      if (o.op === 'add') return str(o.title) ? { ev: 'task', op: 'add', ts: o.ts, id: o.id, task: o.task, title: o.title, owner: str(o.owner), note: str(o.note), by } : null;
      if (o.op in TASK_OPS) return { ev: 'task', op: o.op, ts: o.ts, id: o.id, task: o.task, reason: str(o.reason), by };
      return null;
    default:
      return null;
  }
}

// Every workstream's current state, in the order they were opened. Events about a workstream or
// task that does not exist (yet) are ignored, as is a second `open` of an id: ids are unique, and
// a duplicate is dropped rather than merged.
function foldWorkstreams(text) {
  const byId = new Map();
  const order = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = parseWorkstreamEvent(line);
    if (!e) continue;
    if (e.ev === 'open') {
      if (byId.has(e.id)) continue;
      byId.set(e.id, {
        id: e.id, title: e.title, state: 'open', owner: null, opened: e.ts, updated: e.ts,
        openedBy: e.by, ...(e.note ? { note: e.note } : {}), reopens: [], tasks: [],
      });
      order.push(e.id);
      continue;
    }
    const w = byId.get(e.id);
    if (!w) continue;
    w.updated = Math.max(w.updated, e.ts);
    if (e.ev === 'assign') { w.owner = e.to; continue; }
    if (e.ev === 'close') {
      w.state = e.outcome;
      w.closed = e.ts;
      if (e.commit) w.commit = e.commit; else delete w.commit;
      if (e.branch) w.branch = e.branch; else delete w.branch;
      if (e.reason) w.closeReason = e.reason; else delete w.closeReason;
      continue;
    }
    if (e.ev === 'reopen') {
      // A reopen after a landing is the rework the metric counts; one on an open workstream is a no-op.
      if (w.state === 'open') continue;
      w.reopens.push({ ts: e.ts, from: w.state, closed: w.closed, ...(e.reason ? { reason: e.reason } : {}) });
      w.state = 'open';
      delete w.closed; delete w.commit; delete w.branch; delete w.closeReason;
      continue;
    }
    // A task event.
    if (e.op === 'add') {
      if (w.tasks.some((t) => t.id === e.task)) continue;
      w.tasks.push({ id: e.task, title: e.title, state: 'todo', owner: e.owner, opened: e.ts, changed: e.ts, ...(e.note ? { note: e.note } : {}) });
      continue;
    }
    const t = w.tasks.find((x) => x.id === e.task);
    if (!t) continue;
    t.state = TASK_OPS[e.op];
    t.changed = e.ts;
    if (e.op === 'start' && !t.owner && e.by) t.owner = e.by; // whoever starts an unowned task owns it
    if (e.op === 'block' && e.reason) t.blockedReason = e.reason; else delete t.blockedReason;
    if (e.op === 'done' || e.op === 'drop') t.closed = e.ts; else delete t.closed;
  }
  return order.map((id) => byId.get(id));
}

const nextWorkstreamId = (all) => `ws-${all.reduce((m, w) => Math.max(m, num(WS_ID, w.id)), 0) + 1}`;
const nextTaskId = (w) => `t${w.tasks.reduce((m, t) => Math.max(m, num(TASK_ID, t.id)), 0) + 1}`;

function flagOf(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function has(args, name) { return args.includes(name); }
// The positional arguments: everything that is not a flag or a flag's value.
function positionals(args, valued) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.includes(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

const USAGE = [
  'cos-coord workstream open "<title>" [--note <vault path>]',
  'cos-coord workstream assign <ws> [<sessionId> | none]        (default: this session)',
  'cos-coord workstream close <ws> [--dropped --reason "…"] [--commit <sha>] [--branch <b>]   (default: landed)',
  'cos-coord workstream reopen <ws> --reason "…"',
  'cos-coord workstream task add <ws> "<title>" [--owner <sessionId>] [--note <vault path>]',
  'cos-coord workstream task start|block|done|drop <ws> <task> [--reason "…"]',
  'cos-coord workstream list [--all] [--json]',
].join('\n');

// Plan one write: argv after `workstream`, the current fold, who is acting, and the clock.
// → { ok: true, event, say } | { ok: false, reason }. Refuses what would be a silent no-op, so a
// caller checking the exit code learns that nothing happened.
function planWorkstreamCommand(argv, all, actor, now) {
  const [verb, ...rest] = argv;
  const fail = (reason) => ({ ok: false, reason });
  const by = actor || null;
  const find = (id) => all.find((w) => w.id === id);
  const need = (id) => {
    if (!id) return fail(`needs a workstream id\n${USAGE}`);
    const w = find(id);
    if (!w) return fail(`no workstream "${id}"${all.length ? ` — this workspace has ${all.map((x) => x.id).join(', ')}` : ' — none has been opened in this workspace'}`);
    return { ok: true, w };
  };
  if (verb === 'open') {
    const title = positionals(rest, ['--note']).join(' ').trim();
    if (!title) return fail(`open needs a title\n${USAGE}`);
    const id = nextWorkstreamId(all);
    const note = flagOf(rest, '--note');
    return { ok: true, event: { v: 1, ev: 'open', ts: now, id, title, by, ...(note ? { note } : {}) }, say: `${id} opened — "${title}"` };
  }
  if (verb === 'assign') {
    const [id, who] = positionals(rest, []);
    const n = need(id); if (!n.ok) return n;
    const to = who === 'none' ? null : (who || actor || null);
    if (who === undefined && !actor) return fail('assign needs a session id (or `none`) when run outside a session');
    if ((n.w.owner || null) === to) return fail(`${id} is already ${to ? `owned by ${to}` : 'unowned'}`);
    return { ok: true, event: { v: 1, ev: 'assign', ts: now, id, to, by }, say: `${id} → ${to || 'unowned'}` };
  }
  if (verb === 'close') {
    const [id] = positionals(rest, ['--reason', '--commit', '--branch']);
    const n = need(id); if (!n.ok) return n;
    if (n.w.state !== 'open') return fail(`${id} is already ${n.w.state} — reopen it first`);
    const outcome = has(rest, '--dropped') ? 'dropped' : 'landed';
    const reason = flagOf(rest, '--reason');
    if (outcome === 'dropped' && !reason) return fail('close --dropped needs --reason "…": a dropped workstream nobody can explain is the noise this log exists to prevent');
    const commit = flagOf(rest, '--commit');
    const branch = flagOf(rest, '--branch');
    return {
      ok: true,
      event: { v: 1, ev: 'close', ts: now, id, outcome, ...(commit ? { commit } : {}), ...(branch ? { branch } : {}), ...(reason ? { reason } : {}), by },
      say: `${id} ${outcome}`,
    };
  }
  if (verb === 'reopen') {
    const [id] = positionals(rest, ['--reason']);
    const n = need(id); if (!n.ok) return n;
    if (n.w.state === 'open') return fail(`${id} is open — there is nothing to reopen`);
    const reason = flagOf(rest, '--reason');
    if (!reason) return fail('reopen needs --reason "…" (a revert, a regression): rework is what it measures');
    return { ok: true, event: { v: 1, ev: 'reopen', ts: now, id, reason, by }, say: `${id} reopened` };
  }
  if (verb === 'task') {
    const [op, ...trest] = rest;
    if (op === 'add') {
      const [id, ...words] = positionals(trest, ['--owner', '--note']);
      const n = need(id); if (!n.ok) return n;
      const title = words.join(' ').trim();
      if (!title) return fail(`task add needs a title\n${USAGE}`);
      const task = nextTaskId(n.w);
      const owner = flagOf(trest, '--owner');
      const note = flagOf(trest, '--note');
      return {
        ok: true,
        event: { v: 1, ev: 'task', op: 'add', ts: now, id, task, title, ...(owner ? { owner } : {}), ...(note ? { note } : {}), by },
        say: `${id}/${task} added — "${title}"`,
      };
    }
    if (op in TASK_OPS) {
      const [id, task] = positionals(trest, ['--reason']);
      const n = need(id); if (!n.ok) return n;
      if (!task) return fail(`task ${op} needs a task id — ${id} has ${n.w.tasks.map((t) => t.id).join(', ') || 'no tasks'}`);
      const t = n.w.tasks.find((x) => x.id === task);
      if (!t) return fail(`${id} has no task "${task}" — it has ${n.w.tasks.map((x) => x.id).join(', ') || 'no tasks'}`);
      if (t.state === TASK_OPS[op]) return fail(`${id}/${task} is already ${t.state}`);
      const reason = flagOf(trest, '--reason');
      return { ok: true, event: { v: 1, ev: 'task', op, ts: now, id, task, ...(reason ? { reason } : {}), by }, say: `${id}/${task} → ${TASK_OPS[op]}` };
    }
    return fail(`unknown task verb "${op || ''}"\n${USAGE}`);
  }
  return fail(`${verb ? `unknown verb "${verb}"` : 'needs a verb'}\n${USAGE}`);
}

// One readable block per workstream, for `cos-coord workstream list`.
function formatWorkstream(w, now) {
  const age = (ms) => { const h = ms / 3600000; return h < 1 ? `${Math.max(0, Math.round(ms / 60000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`; };
  const done = w.tasks.filter((t) => t.state === 'done').length;
  const live = w.tasks.filter((t) => t.state !== 'dropped').length;
  let s = `${w.id}  ${w.state.toUpperCase().padEnd(7)}  ${w.title}  (${w.owner || 'unowned'} · ${age((w.closed || now) - w.opened)}${live ? ` · ${done}/${live} tasks` : ''})`;
  for (const t of w.tasks) s += `\n    ${t.id.padEnd(4)} ${t.state.padEnd(7)}  ${t.title}${t.owner ? `  — ${t.owner}` : ''}${t.blockedReason ? `  (blocked: ${t.blockedReason})` : ''}`;
  return s;
}

module.exports = { TASK_STATES, USAGE, parseWorkstreamEvent, foldWorkstreams, planWorkstreamCommand, formatWorkstream };
