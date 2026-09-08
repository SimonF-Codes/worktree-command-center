// Pure logic for the toast stack: what is on screen, what is waiting, when things expire.
// No DOM, no timers — the renderer in toast.ts owns those and calls in with a `now`.
//
// Behaviour:
// - At most MAX_VISIBLE (3) toasts are on screen at once. Everything past that WAITS in a
//   queue and is promoted as slots free up, so a burst of messages can never carpet the
//   screen. The renderer shows a "+N more" pill for what is waiting.
// - Promotion is PRIORITY-ordered, not plain FIFO: an error must not sit behind three
//   "Opening…" notices. Within one severity it stays first-in-first-out.
// - Identical consecutive messages DEDUPE into one toast with a ×N counter instead of
//   stacking N copies — the attention pulses in terminals-grid can repeat the same line
//   many times in a row, and three slots of the same sentence is three wasted slots.
// - Lifetime scales with severity: you need longer to read (and act on) a failure than to
//   register "Saved". Nothing is permanent; the renderer also allows click-to-dismiss.
// - A toast may carry ONE action (an Undo button). Those never dedupe and never share a
//   lifetime with a plain message: an Undo you cannot reach before it expires is not an Undo.

/** Severity of a toast. The first four are the real vocabulary; `done`/`help`/`input` are
 *  kept as aliases because the per-tile attention markers already speak in those terms
 *  (finished / stuck / needs-you) and pass them straight through. */
export type ToastVariant = 'success' | 'error' | 'warn' | 'info' | 'done' | 'help' | 'input';

/** The four severities everything collapses to before rendering. */
export type Severity = 'success' | 'error' | 'warn' | 'info';

export const MAX_VISIBLE = 3;

/** How long each severity stays up, in ms. An error gets long enough to read a path or a
 *  git message out of it; a success just needs to be noticed. */
export const DURATION: Record<Severity, number> = {
	info: 3000,
	success: 3500,
	warn: 5000,
	error: 8000,
};

/** Promotion order when a slot frees. Lower sorts first. */
const PRIORITY: Record<Severity, number> = { error: 0, warn: 1, success: 2, info: 3 };

/** A single button on a toast. `run` fires once, and the toast is dismissed with it. */
export interface ToastAction { label: string; run: () => void; }

export interface ToastPushOptions {
	action?: ToastAction;
	/** Overrides the severity's lifetime — used to give an action time to be clicked. */
	durationMs?: number;
}

export interface ToastItem {
	id: number;
	msg: string;
	severity: Severity;
	/** Offered as a button; the toast never dedupes while it has one. */
	action?: ToastAction;
	/** This toast's own lifetime, so a promotion or a hover-hold re-uses the SAME clock rather
	 *  than silently demoting an 8s Undo back to its severity's 3s. */
	durationMs: number;
	/** How many times this same message arrived — rendered as "×N" when >1. */
	count: number;
	/** ms epoch at which the renderer should drop this toast. */
	expiresAt: number;
	/** ms epoch the toast was created — FIFO tiebreak within a severity. */
	createdAt: number;
}

export interface ToastState {
	visible: ToastItem[];
	queued: ToastItem[];
	nextId: number;
}

export function emptyToasts(): ToastState {
	return { visible: [], queued: [], nextId: 1 };
}

/** Collapse the alias variants onto the four real severities. */
export function toSeverity(v?: ToastVariant): Severity {
	switch (v) {
		case 'done': return 'success';
		case 'help': return 'error';
		case 'input': return 'warn';
		case undefined: return 'info';
		default: return v;
	}
}

/** Number of toasts waiting for a slot — the "+N more" pill. */
export function overflowCount(s: ToastState): number {
	return s.queued.length;
}

/** Fill empty visible slots from the queue, most urgent first. */
function promote(s: ToastState, now: number): ToastState {
	if (s.visible.length >= MAX_VISIBLE || s.queued.length === 0) return s;
	const order = [...s.queued].sort((a, b) =>
		PRIORITY[a.severity] - PRIORITY[b.severity] || a.createdAt - b.createdAt);
	const moving = order.slice(0, MAX_VISIBLE - s.visible.length);
	const movingIds = new Set(moving.map((t) => t.id));
	return {
		...s,
		// A promoted toast starts its clock NOW — it was not readable while it waited, so
		// counting that wait against its lifetime would flash it for whatever time was left.
		visible: [...s.visible, ...moving.map((t) => ({ ...t, expiresAt: now + t.durationMs }))],
		queued: s.queued.filter((t) => !movingIds.has(t.id)),
	};
}

/** Add a message. Identical text+severity already on screen or queued bumps that toast's
 *  count and restarts its clock instead of adding a second copy. */
export function pushToast(s: ToastState, msg: string, variant: ToastVariant | undefined, now: number, opts: ToastPushOptions = {}): ToastState {
	const severity = toSeverity(variant);
	const durationMs = opts.durationMs && opts.durationMs > 0 ? opts.durationMs : DURATION[severity];
	// An actionable toast is a distinct offer, not a repeat: collapsing two of them would hand
	// the second close's Undo the FIRST close's action, which would restore the wrong workspace.
	const same = (t: ToastItem): boolean => !opts.action && !t.action && t.msg === msg && t.severity === severity;

	const vIdx = s.visible.findIndex(same);
	if (vIdx >= 0) {
		const hit = s.visible[vIdx]!;
		const visible = [...s.visible];
		visible[vIdx] = { ...hit, count: hit.count + 1, expiresAt: now + hit.durationMs };
		return { ...s, visible };
	}
	const qIdx = s.queued.findIndex(same);
	if (qIdx >= 0) {
		const hit = s.queued[qIdx]!;
		const queued = [...s.queued];
		queued[qIdx] = { ...hit, count: hit.count + 1 };
		return { ...s, queued };
	}

	const item: ToastItem = {
		id: s.nextId, msg, severity, count: 1, durationMs,
		createdAt: now, expiresAt: now + durationMs,
		...(opts.action ? { action: opts.action } : {}),
	};
	const next: ToastState = { ...s, nextId: s.nextId + 1 };
	return s.visible.length < MAX_VISIBLE
		? { ...next, visible: [...s.visible, item] }
		: { ...next, queued: [...s.queued, item] };
}

/** Drop everything whose time is up, then backfill from the queue. */
export function expireToasts(s: ToastState, now: number): ToastState {
	const alive = s.visible.filter((t) => t.expiresAt > now);
	if (alive.length === s.visible.length) return promote(s, now);
	return promote({ ...s, visible: alive }, now);
}

/** Manual dismiss (click). Removes from wherever it is, then backfills. */
export function dismissToast(s: ToastState, id: number, now: number): ToastState {
	return promote({
		...s,
		visible: s.visible.filter((t) => t.id !== id),
		queued: s.queued.filter((t) => t.id !== id),
	}, now);
}

/** Push an expiry out while the pointer rests on a toast (hover-to-hold). */
export function holdToast(s: ToastState, id: number, now: number): ToastState {
	return {
		...s,
		visible: s.visible.map((t) => t.id === id ? { ...t, expiresAt: now + t.durationMs } : t),
	};
}
