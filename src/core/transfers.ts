// Session Transfers, P5a (design §11): a read-only fold of what the overseer has already sent down,
// joined to the sessions file. Pure: no window, no fs, no clock — the CLI gathers the files and the
// tree (P6) will call the same function, so `wcc-team transfers --json` is what the tree draws.
//
// What it reads: the claimed requests in `god-outbox/.done/` (spawn · tell · watch · close, each a
// JSON file the app renamed there when it acted on it) and one workspace's records from
// `.terminal-sessions.json`. What it can say: what was SENT, by whom, to whom. Never whether it
// arrived — that is P5b — and the absence of an error file is not taken as delivery.
//
// The join: a request's `from` is the sender's sessionId. A spawn's child is the session whose
// parentSessionId is that sender AND whose name is the request's `name`. A tell / watch target is
// a name, resolved the way the app resolves one (exact, then case-insensitive). No match, or more
// than one, is reported as unmatched and never guessed. A request without `from` (everything
// written before 2026-11-22T18:02Z) has no sender: it is plain lineage, not a transfer.
//
// Every string the fold puts out goes through transferSubject(): any local process can write these
// files, and the output is shown in a window with Node on and read by the overseer as a model.

/** The longest subject, in code points, ellipsis included. */
export const SUBJECT_MAX = 120;

/** Line breaks, including the Unicode ones and the C0/C1 ones that read as a break. */
const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;
/** The removed set, named in the design: C0 and C1 controls (and DEL); the zero-width characters
 *  U+200B–U+200D and U+2060; the marks U+200E, U+200F, U+061C; the direction embeddings and
 *  overrides U+202A–U+202E; the isolates U+2066–U+2069; the tag block U+E0000–U+E007F. Tab is
 *  turned into a space first, so it separates words rather than joining them. */
const STRIPPED = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2060\u061C\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

/** One safe line of `text`: the first line that is non-empty once cleaned, with the named characters
 *  removed and whitespace collapsed, cut to SUBJECT_MAX code points. Non-strings give ''. */
export function transferSubject(text: unknown): string {
	if (typeof text !== 'string') return '';
	for (const raw of text.split(LINE_BREAK)) {
		const line = raw.replace(/\t/g, ' ').replace(STRIPPED, '').replace(/\s+/g, ' ').trim();
		if (!line) continue;
		const cps = Array.from(line);
		return cps.length <= SUBJECT_MAX ? line : `${cps.slice(0, SUBJECT_MAX - 1).join('').trimEnd()}…`;
	}
	return '';
}

export type TransferKind = 'spawn' | 'tell' | 'watch' | 'close';
export const TRANSFER_KINDS: readonly TransferKind[] = ['spawn', 'tell', 'watch', 'close'];

/** A session as the fold names it. `name` is null for an overseer, whose record has none. */
export interface SessionRef { sessionId: string; name: string | null; kind: string | null }

/** How a request joined to the floor.
 *  - edge: the receiver is the sender's child — the one case the tree draws.
 *  - off-edge: it reached a session, but not one under the sender; no edge to draw it on.
 *  - unmatched: no session, or more than one, answers to it now. Listed, never drawn, never guessed.
 *  - unattributed: no `from` — a request from before the sender was recorded. Plain lineage.
 *  - closed: a close. Folded and listed; never drawn, because the node it ended is gone. */
export type TransferMatch =
	| { state: 'edge'; to: SessionRef }
	| { state: 'off-edge'; to: SessionRef }
	| { state: 'unmatched'; reason: string }
	| { state: 'unattributed' }
	| { state: 'closed' };

export interface Transfer {
	/** The request file's name without `.json`: `<ts>-<id>`. */
	id: string;
	/** ms since the epoch: the request's own `ts`, else its file name's prefix, else null. */
	ts: number | null;
	kind: TransferKind;
	/** The sender, when the request names one. `name`/`kind` are null if it is no longer on the floor. */
	from: SessionRef | null;
	/** The name the request addressed: a spawn's `name`, else the `target`. */
	toName: string | null;
	/** transferSubject of the brief, message or watch note; null for a close. */
	subject: string | null;
	/** The full text's length in characters, so a cut subject is visibly a cut. */
	length: number | null;
	/** A spawn's brief, as given: the hover's "role and isolation it was given". */
	brief?: { repo: string | null; role: string | null; isolation: string | null; taskClass: string | null };
	/** P5a can only ever say this. P5b adds the outcome. */
	delivery: 'sent';
	match: TransferMatch;
	/** True exactly when match.state is 'edge'. */
	drawn: boolean;
}

export interface TransferFold {
	schema: 1;
	transfers: Transfer[];
	/** Files that are not a readable request of a folded kind: unparsable, or another kind. */
	skipped: Array<{ file: string; reason: string }>;
	counts: { requests: number; byKind: Record<TransferKind, number>; byState: Record<TransferMatch['state'], number> };
}

/** One claimed request file, as read. */
export interface RequestFile { file: string; text: string }

export interface FoldInput {
	requests: readonly RequestFile[];
	/** One workspace's records from `.terminal-sessions.json` — raw, as parsed. */
	sessions: readonly unknown[];
}

interface Rec { sessionId: string; name: string | null; kind: string | null; parent: string | null }

const rawStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const safe = (v: unknown): string | null => { const s = rawStr(v); return s === null ? null : (transferSubject(s) || null); };

function records(sessions: readonly unknown[]): Rec[] {
	const out: Rec[] = [];
	for (const r of sessions) {
		if (!r || typeof r !== 'object') continue;
		const o = r as Record<string, unknown>;
		const sessionId = rawStr(o.sessionId);
		if (!sessionId || o.kind === 'journal') continue; // a journal is a note, not a session
		out.push({ sessionId, name: typeof o.name === 'string' ? o.name : null, kind: rawStr(o.kind), parent: rawStr(o.parentSessionId) });
	}
	return out;
}

const ref = (r: Rec): SessionRef => ({ sessionId: safe(r.sessionId) ?? '', name: safe(r.name), kind: safe(r.kind) });

/** The app's resolution (god.ts resolveTellTarget: exact, then case-insensitive), except that two
 *  answers are reported as two rather than taking the first. */
function byName(name: string, among: readonly Rec[]): Rec[] {
	const exact = among.filter((r) => r.name === name);
	if (exact.length) return exact;
	const lc = name.toLowerCase();
	return among.filter((r) => r.name !== null && r.name.toLowerCase() === lc);
}

const tsOfFile = (file: string): number | null => { const m = /^(\d{10,})-/.exec(file); return m ? Number(m[1]) : null; };
const label = (r: Rec): string => `${safe(r.name) ?? (r.kind === 'god' ? 'an overseer' : 'unnamed')} (${(safe(r.sessionId) ?? '').slice(0, 8)})`;

/** Fold the claimed requests against the sessions on the floor. Ordered oldest first. */
export function foldTransfers(input: FoldInput): TransferFold {
	const recs = records(input.sessions);
	const bySession = new Map(recs.map((r) => [r.sessionId, r]));
	const skipped: TransferFold['skipped'] = [];
	type Parsed = { t: Transfer; rawFrom: string | null; rawTo: string | null };
	const parsed: Parsed[] = [];

	for (const { file, text } of input.requests) {
		const fileSafe = transferSubject(file);
		let o: Record<string, unknown>;
		try {
			const p: unknown = JSON.parse(text);
			if (!p || typeof p !== 'object' || Array.isArray(p)) { skipped.push({ file: fileSafe, reason: 'not a JSON object' }); continue; }
			o = p as Record<string, unknown>;
		} catch { skipped.push({ file: fileSafe, reason: 'invalid JSON' }); continue; }
		const kind = o.kind;
		if (!TRANSFER_KINDS.includes(kind as TransferKind)) { skipped.push({ file: fileSafe, reason: `kind ${safe(kind) ?? '(missing)'} is not a transfer` }); continue; }
		const k = kind as TransferKind;
		const body = k === 'spawn' ? o.task : k === 'tell' ? o.message : k === 'watch' ? o.note : undefined;
		const rawFrom = rawStr(o.from);
		const rawTo = rawStr(k === 'spawn' ? o.name : o.target);
		const sender = rawFrom ? bySession.get(rawFrom) : undefined;
		const t: Transfer = {
			id: transferSubject(file.replace(/\.json$/i, '')),
			ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : tsOfFile(file),
			kind: k,
			from: rawFrom ? (sender ? ref(sender) : { sessionId: safe(rawFrom) ?? '', name: null, kind: null }) : null,
			toName: safe(rawTo),
			subject: k === 'close' ? null : transferSubject(body),
			length: typeof body === 'string' ? body.length : null,
			...(k === 'spawn' ? { brief: { repo: safe(o.repo), role: safe(o.role), isolation: safe(o.isolation), taskClass: safe(o.taskClass) } } : {}),
			delivery: 'sent',
			match: { state: 'unattributed' },
			drawn: false,
		};
		parsed.push({ t, rawFrom, rawTo });
	}
	parsed.sort((a, b) => (a.t.ts ?? -Infinity) - (b.t.ts ?? -Infinity) || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0));

	// Spawns first: they say when each child arrived, which the tells after them are checked against.
	const spawnedAt = new Map<string, number | null>();
	const spawnOf = new Map<string, Parsed>();
	for (const p of parsed) {
		if (p.t.kind !== 'spawn' || !p.rawFrom) continue;
		if (!p.rawTo) { p.t.match = { state: 'unmatched', reason: 'the request named no child, so the app chose its name and nothing on disk joins them' }; continue; }
		const hits = byName(p.rawTo, recs.filter((r) => r.parent === p.rawFrom));
		if (hits.length !== 1) { p.t.match = { state: 'unmatched', reason: noMatch(p.rawTo, hits, 'under the sender') }; continue; }
		const child = hits[0]!;
		const earlier = spawnOf.get(child.sessionId);
		if (earlier) earlier.t.match = { state: 'unmatched', reason: `a later spawn of "${safe(p.rawTo)}" by the same sender is the session on the floor now` };
		spawnOf.set(child.sessionId, p);
		spawnedAt.set(child.sessionId, p.t.ts);
		p.t.match = { state: 'edge', to: ref(child) };
	}
	for (const p of parsed) {
		if (p.t.kind === 'spawn' || !p.rawFrom) continue;
		if (p.t.kind === 'close') { p.t.match = { state: 'closed' }; continue; }
		if (!p.rawTo) { p.t.match = { state: 'unmatched', reason: 'the request names no target' }; continue; }
		const hits = byName(p.rawTo, recs.filter((r) => r.kind !== 'god'));
		if (hits.length !== 1) { p.t.match = { state: 'unmatched', reason: noMatch(p.rawTo, hits, 'on the floor') }; continue; }
		const to = hits[0]!;
		const born = spawnedAt.get(to.sessionId);
		if (born != null && p.t.ts != null && p.t.ts < born) {
			p.t.match = { state: 'unmatched', reason: `sent before ${label(to)} was spawned, so it went to an earlier session of that name` };
			continue;
		}
		p.t.match = { state: to.parent === p.rawFrom ? 'edge' : 'off-edge', to: ref(to) };
	}

	const byKind = { spawn: 0, tell: 0, watch: 0, close: 0 } as Record<TransferKind, number>;
	const byState = { edge: 0, 'off-edge': 0, unmatched: 0, unattributed: 0, closed: 0 } as Record<TransferMatch['state'], number>;
	const transfers = parsed.map((p) => {
		p.t.drawn = p.t.match.state === 'edge';
		byKind[p.t.kind]++;
		byState[p.t.match.state]++;
		return p.t;
	});
	return { schema: 1, transfers, skipped, counts: { requests: input.requests.length, byKind, byState } };
}

function noMatch(name: string, hits: readonly Rec[], where: string): string {
	if (!hits.length) return `no session ${where} is named "${safe(name)}" now`;
	return `"${safe(name)}" matches ${hits.length} sessions ${where} (${hits.map(label).join(', ')}), so it is not guessed`;
}

/** The transfers a session sent or received — `--session <id>`, and what one node's edges hold. */
export function transfersFor(fold: TransferFold, sessionId: string): Transfer[] {
	const id = transferSubject(sessionId);
	return fold.transfers.filter((t) => t.from?.sessionId === id || ((t.match.state === 'edge' || t.match.state === 'off-edge') && t.match.to.sessionId === id));
}
