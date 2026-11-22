// Session identity and lineage (V2 ladder step 6). Pure: no window, no fs — the grid and the
// tiles call these, and the tests call them the same way.
//
// Why a sessionId at all: tile ids come from `nextTileId++` and are reissued on EVERY restore,
// and a folder session's worktree path is shared with every other session on that folder. So
// neither can key a parent edge that has to survive a restart. A sessionId is minted ONCE, when
// the session is first created, and from then on is only ever read back from its record.
import { randomUUID } from 'crypto';

/** A fresh session id. The only place one is ever created. */
export function mintSessionId(): string { return randomUUID(); }

/** The identity fields a session record carries. */
export interface SessionIdentity { sessionId: string }

/** The shape these helpers need from a persisted record. */
export interface IdentityRecord { kind?: string; sessionId?: unknown }

function usableId(v: unknown): v is string { return typeof v === 'string' && v.trim() !== ''; }

/** Journals are notes, not sessions: nothing spawns them and nothing reports to them. */
function isSession(rec: IdentityRecord): boolean { return rec.kind !== 'journal'; }

/** Give every session record that lacks a sessionId — one an older build wrote, or one whose
 *  value was hand-edited into junk — a freshly minted one. Records that already have one are
 *  returned untouched, so running this over its own output mints nothing: that is the "once".
 *  `minted` tells the caller whether the file needs healing. Never mutates its input. */
export function ensureSessionIds<T extends IdentityRecord>(recs: readonly T[], mint: () => string = mintSessionId): { records: T[]; minted: number } {
	let minted = 0;
	const records = recs.map((r) => {
		if (!isSession(r) || usableId(r.sessionId)) return r;
		minted++;
		return { ...r, sessionId: mint() };
	});
	return { records, minted };
}

/** The identity a RESTORED session runs with: read from its record, never re-minted. A record
 *  that somehow still has none (ensureSessionIds was skipped) gets one here rather than none,
 *  and the next persist writes it. */
export function restoreIdentity(rec: IdentityRecord, mint: () => string = mintSessionId): SessionIdentity {
	return { sessionId: usableId(rec.sessionId) ? rec.sessionId : mint() };
}

/** The identity a NEW session runs with — the one place a spawn mints. */
export function newIdentity(mint: () => string = mintSessionId): SessionIdentity {
	return { sessionId: mint() };
}

/** The identity fields as they are written into a session record. */
export function identityFields(id: SessionIdentity): SessionIdentity {
	return { sessionId: id.sessionId };
}
