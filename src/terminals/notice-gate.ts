// Never type over the user: a draft tracker + a notice queue. Pure — no DOM, no timers, no IO.
//
// The bug this exists for: GodConsole.notify() and TerminalTile.sendLine() wrote a notification
// straight into the PTY as keystrokes and then pressed Enter. Neither looked at what was already
// in Claude's input box, so a notice arriving while the user was mid-sentence landed INSIDE his
// draft and the Enter submitted the mixture — as if he had written it.
//
// The invariant: never write to a PTY the user is actively typing into. Queue instead, and flush
// on the transition back to an empty input box.
//
// Where the draft state comes from: every keystroke already passes through xterm's `onData` on
// its way to the PTY, so the input box's length can be TRACKED from that stream rather than read
// off the screen. We deliberately do NOT parse the TUI's rendering for the prompt line — it
// changes often and that approach has burned this repo before (the usage-bar saga).
//
// It is a heuristic, so it can drift. The two directions are NOT equally bad and the rules below
// are biased accordingly:
//   - drift toward "empty" re-creates the original bug (we type over a live draft) — never guess
//     that way; anything ambiguous counts as still drafting.
//   - drift toward "non-empty" stalls delivery, which the queue badge makes visible and any of
//     Enter / Esc / Ctrl+U / Ctrl+C clears in one keypress. It is also bounded by ready().

import { isUserInput } from './ready-queue';

/** Cap on queued notices. Exact duplicates coalesce before this bites, and overflow MERGES into
 *  the last entry rather than discarding it — a watch notice is the only thing that tells the
 *  overseer a worker finished, so nothing may ever be dropped. */
export const MAX_QUEUED_NOTICES = 50;

/** How long the keyboard must have been quiet before a ready marker is allowed to resync the
 *  draft to empty. See NoticeGate.ready() for why this guard exists at all. */
export const RESYNC_QUIET_MS = 1500;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface DraftState {
	/** approximate number of characters sitting in Claude's input box */
	len: number;
	/** when the HUMAN last typed (focus/mouse reports on the same channel don't count) */
	lastInputAt: number;
}

export interface DraftChange extends DraftState {
	/** this chunk UNAMBIGUOUSLY emptied the box (Enter, Esc, Ctrl+U, Ctrl+C) — true even if we
	 *  already believed it was empty, which is what makes "press Enter" a reliable way out of a
	 *  tracker that has drifted non-empty. */
	cleared: boolean;
}

export function emptyDraft(): DraftState {
	return { len: 0, lastInputAt: 0 };
}

/** Characters a paste actually puts in the box (its newlines included — a pasted newline lands
 *  in the box, it does not submit). */
function countPrintable(s: string): number {
	let n = 0;
	for (const ch of s) if (ch === '\n' || ch === '\r' || ch.charCodeAt(0) >= 0x20) n += 1;
	return n;
}

/** Fold one raw xterm `onData` chunk into the draft state.
 *
 *  `pasting` is the caller's own "I am mid-term.paste()" flag, for the case where bracketed paste
 *  is off and the pasted text arrives as plain data — its newlines must not read as a submit. */
export function applyDraftChunk(state: DraftState, data: string, now: number, pasting = false): DraftChange {
	// Claude Code turns on focus reporting, so xterm answers focus/blur — including the focus
	// changes the app itself causes — down the same channel as typing. Those are not the user.
	if (!data || !isUserInput(data)) return { ...state, cleared: false };
	if (pasting || data.startsWith(PASTE_START)) {
		const body = data.split(PASTE_START).join('').split(PASTE_END).join('');
		return { len: state.len + countPrintable(body), lastInputAt: now, cleared: false };
	}
	if (data === '\x1b') return { len: 0, lastInputAt: now, cleared: true };  // bare Esc clears the box
	// Arrows, F-keys, Alt/Shift+Enter: the user is engaged, but we can't say the box shrank — and
	// Alt/Shift+Enter inserts a newline rather than submitting, so this must NOT read as a clear.
	if (data.startsWith('\x1b')) return { ...state, lastInputAt: now, cleared: false };
	if (data.includes('\r')) return { len: 0, lastInputAt: now, cleared: true };  // Enter submits
	let len = state.len;
	let cleared = false;
	for (const ch of data) {
		if (ch === '\x7f' || ch === '\b') len = Math.max(0, len - 1);            // backspace / delete
		else if (ch === '\x15' || ch === '\x03') { len = 0; cleared = true; }    // Ctrl+U / Ctrl+C
		else if (ch === '\n') len += 1;                                          // newline IN the box
		else if (ch.charCodeAt(0) >= 0x20) len += 1;                             // printable
	}
	return { len, lastInputAt: now, cleared };
}

/** Add a notice to the pending queue. Exact duplicates coalesce (a chatty floor repeating itself
 *  can't flood it); past the cap, the overflow is MERGED into the last entry so the text still
 *  gets through — the queue never discards. */
export function queueNotice(queue: readonly string[], text: string, cap = MAX_QUEUED_NOTICES): string[] {
	if (queue.includes(text)) return [...queue];
	if (queue.length < Math.max(1, cap)) return [...queue, text];
	const head = queue.slice(0, -1);
	return [...head, `${queue[queue.length - 1]}\n${text}`];
}

/** Everything pending as ONE message. Embedded newlines land as newlines in Claude's input box
 *  (that is exactly why sendLine's Enter has to be a separate write), so the whole backlog is
 *  delivered by a single submit instead of N racing ones. */
export function flushJoin(queue: readonly string[]): string {
	return queue.join('\n');
}

/** `immediate` — the box was empty, write it now, exactly as the code did before this existed.
 *  `flush`     — a backlog being released; the caller should let the keystroke that emptied the
 *                box reach the TUI first (see FLUSH_SETTLE_MS at the call sites). */
export type NoticeDeliveryKind = 'immediate' | 'flush';

export interface NoticeGateOpts {
	/** Write the text into the PTY (and press Enter however that site already does it). */
	deliver: (text: string, kind: NoticeDeliveryKind) => void;
	/** Fired whenever the number of waiting notices changes — drives the out-of-band badge. A
	 *  notice that silently never arrives is indistinguishable from no notice at all. */
	onQueueChange?: (queued: number) => void;
	now?: () => number;
	cap?: number;
	resyncQuietMs?: number;
}

/** One PTY's gate: tracks its draft, holds notices while one is in progress, releases them when
 *  the box goes empty. Shared by GodConsole (Kane's notify) and TerminalTile (sendLine / tell). */
export class NoticeGate {
	private draft: DraftState = emptyDraft();
	private queue: string[] = [];

	constructor(private opts: NoticeGateOpts) {}

	/** True while the user appears to have unsubmitted text in the box. */
	get drafting(): boolean { return this.draft.len > 0; }
	get queued(): number { return this.queue.length; }
	/** Pending notices, for tests and for the badge's tooltip. */
	get pending(): readonly string[] { return this.queue; }
	get draftLength(): number { return this.draft.len; }

	/** Feed every raw chunk xterm hands us, AFTER it has been forwarded to the PTY — so the
	 *  user's own Enter reaches the TUI before any notice we release because of it. */
	input(data: string, pasting = false): void {
		const before = this.draft.len;
		const next = applyDraftChunk(this.draft, data, this.now(), pasting);
		this.draft = { len: next.len, lastInputAt: next.lastInputAt };
		if (next.len === 0 && (before > 0 || next.cleared)) this.flush();
	}

	/** Queue or deliver a notification. Empty box → straight through, unchanged behaviour. */
	notify(text: string): void {
		this.queue = queueNotice(this.queue, text, this.opts.cap ?? MAX_QUEUED_NOTICES);
		this.opts.onQueueChange?.(this.queue.length);
		if (this.draft.len === 0) this.flush('immediate');
	}

	/** The session's ready marker: a turn just ended. Used to bound how long a mis-tracked draft
	 *  can stall delivery — without it the counter could be wrong indefinitely.
	 *
	 *  The quiet guard is deliberate and is NOT in the design: a turn ending does not actually
	 *  prove the box is empty, because the user can type while Claude works and that text is
	 *  still sitting there when the turn ends. Resetting blindly would re-create the very bug
	 *  this module exists to kill. So the marker only resyncs a draft the keyboard has not
	 *  touched for `resyncQuietMs` — still bounded (markers keep arriving), never on top of
	 *  someone demonstrably mid-sentence. */
	ready(): void {
		const quiet = this.opts.resyncQuietMs ?? RESYNC_QUIET_MS;
		if (this.draft.len > 0 && this.now() - this.draft.lastInputAt >= quiet) this.draft = { ...this.draft, len: 0 };
		if (this.draft.len === 0) this.flush();
	}

	/** The user asked for the backlog now (badge click), draft or no draft. Their call, made with
	 *  the count in front of them — this is the one path allowed to type into a live box. */
	flushNow(): void {
		this.draft = { ...this.draft, len: 0 };
		this.flush();
	}

	/** Session restarted underneath us (⟳ / account switch): the new TUI's box is empty. The
	 *  queue is KEPT — a restart is not a reason to lose a notice — and goes out on the next
	 *  ready marker or the next notify, rather than into a still-booting TUI. */
	reset(): void {
		this.draft = emptyDraft();
	}

	private flush(kind: NoticeDeliveryKind = 'flush'): void {
		if (this.queue.length === 0) return;
		const text = flushJoin(this.queue);
		this.queue = [];                    // cleared BEFORE deliver, so a re-entrant notify queues cleanly
		this.opts.onQueueChange?.(0);
		this.opts.deliver(text, kind);
	}

	private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
}
