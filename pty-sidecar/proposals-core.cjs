'use strict';
// Spawn proposals (V2 Team Floor step 10, FR-51..54) — the pure fold, shared by the app
// (src/core/proposals.ts) and `cos-coord proposals`, so the proposer and the app read one answer.
//
// `<coordDir>/spawn-proposals.jsonl` is APPEND-ONLY: persist() rewrites config.json and the
// sessions file from memory and would discard an outside edit (D2), and a correction is a new line,
// never an edit. One line per event:
//
//   {"v":1,"ev":"propose","ts":…,"id":"p-…","from":{"sessionId","role","name"},"to":"<parent>"|null,
//    "toName":…,"workstreamId":…|null,"role":"researcher","task":"…","why":"…"}
//   {"v":1,"ev":"accept","ts":…,"id":"p-…","by":"<sessionId>","byName":"…","spawned":"<child sessionId>"}
//   {"v":1,"ev":"decline","ts":…,"id":"p-…","by":"<sessionId>","byName":"…","reason":"…"}
//
// Names are written beside ids so the file reads on its own: `cos-coord proposals` has no roster.
//   {"v":1,"ev":"stale","ts":…,"id":"p-…","reason":"…"}
//
// A proposal is INERT. Nothing in this file, or anywhere, turns one into a spawn: only a session
// whose role already holds spawns: can, and accepting re-runs checkDelegation in full.

const STATES = ['open', 'accepted', 'declined', 'stale'];
const DECISIONS = { accept: 'accepted', decline: 'declined', stale: 'stale' };

function str(v) { return typeof v === 'string' && v.trim() ? v : null; }

// One line → an event, or null for anything unreadable (a torn last line, a hand edit).
function parseProposalEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || typeof o.ts !== 'number' || !str(o.id)) return null;
  if (o.ev === 'propose') {
    const f = o.from && typeof o.from === 'object' ? o.from : null;
    if (!f || !str(f.sessionId) || !str(o.role) || !str(o.task) || !str(o.why)) return null;
    return {
      ev: 'propose', ts: o.ts, id: o.id,
      from: { sessionId: f.sessionId, role: str(f.role) || '', name: str(f.name) || f.sessionId },
      to: str(o.to), ...(str(o.toName) ? { toName: o.toName } : {}), workstreamId: str(o.workstreamId), role: o.role, task: o.task, why: o.why,
    };
  }
  if (o.ev in DECISIONS) {
    return { ev: o.ev, ts: o.ts, id: o.id, by: str(o.by), byName: str(o.byName), reason: str(o.reason), spawned: str(o.spawned) };
  }
  return null;
}

// The current state of every proposal, in the order they were proposed. Only an OPEN proposal can
// be decided, so the first decision wins and anything after it is ignored: an accept cannot be
// declined afterwards, and a race between two deciders has exactly one winner on disk.
function foldProposals(text) {
  const byId = new Map();
  const order = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = parseProposalEvent(line);
    if (!e) continue;
    if (e.ev === 'propose') {
      if (byId.has(e.id)) continue; // ids are unique; a duplicate is ignored, not merged
      const { ev, ...p } = e;
      byId.set(e.id, { ...p, state: 'open' });
      order.push(e.id);
      continue;
    }
    const p = byId.get(e.id);
    if (!p || p.state !== 'open') continue;
    p.state = DECISIONS[e.ev];
    p.decidedTs = e.ts;
    if (e.by) p.decidedBy = e.by;
    if (e.byName) p.decidedByName = e.byName;
    if (e.reason) p.reason = e.reason;
    if (e.spawned) p.spawned = e.spawned;
  }
  return order.map((id) => byId.get(id));
}

// What "the same proposal" means for rule 2 (a declined proposal is not re-proposed): the same
// role and the same task, whitespace and case folded, from the same session.
function proposalKey(role, task) {
  return `${String(role).trim().toLowerCase()}\n${String(task).trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

// A one-line summary, for `cos-coord proposals`.
function formatProposal(p, names) {
  const nm = (id, fallback) => (id && names && names[id]) || fallback || id || 'nobody';
  const task = p.task.length > 80 ? `${p.task.slice(0, 79)}…` : p.task;
  let line = `${p.id}  ${p.state.toUpperCase().padEnd(8)}  ${p.role} — "${task}"  (${p.from.name} → ${p.to ? nm(p.to, p.toName) : 'unassigned'})`;
  if (p.state === 'open') line += `\n    why: ${p.why}`;
  if (p.state === 'declined') line += `\n    declined by ${nm(p.decidedBy, p.decidedByName)}: ${p.reason || '(no reason)'}`;
  if (p.state === 'accepted') line += `\n    accepted by ${nm(p.decidedBy, p.decidedByName)}${p.spawned ? ` — spawned session ${p.spawned}` : ''}`;
  if (p.state === 'stale') line += `\n    stale: ${p.reason || 'its proposer ended'}`;
  return line;
}

module.exports = { STATES, parseProposalEvent, foldProposals, proposalKey, formatProposal };
