// Transient bottom-right toasts (replaces Obsidian's `new Notice(msg)`).
//
// This file is only the RENDERER — every rule about what shows, what waits, what dedupes
// and when things expire lives in the pure toast-queue module, where it is unit-tested.
// Here we just diff that state into DOM and run the clock.
//
// Two things the old implementation got wrong, both fixed here:
//  - Every toast was `position:fixed; right:16px; bottom:16px`, so two toasts fired close
//    together rendered exactly ON TOP of each other and you only ever read the last one.
//    They now live in one flow container that stacks them.
//  - Colours were hardcoded (#1e2030) and ignored the app themes. They are CSS variables now.

import {
	emptyToasts, pushToast, expireToasts, dismissToast, holdToast, overflowCount,
	type ToastState, type ToastVariant, type ToastPushOptions,
} from './toast-queue';

export type { ToastVariant, ToastAction, ToastPushOptions } from './toast-queue';

const TICK_MS = 100;

let state: ToastState = emptyToasts();
let host: HTMLElement | null = null;
let timer: number | null = null;
/** Toast the pointer is currently resting on — its clock is held until the pointer leaves. */
let hoveredId: number | null = null;

function ensureHost(): HTMLElement {
	if (host?.isConnected) return host;
	host = document.createElement('div');
	host.className = 'wcc-toast-host';
	host.setAttribute('role', 'status');
	host.setAttribute('aria-live', 'polite');
	document.body.appendChild(host);
	return host;
}

/** Rebuild the stack. Small enough (≤3 nodes + a pill) that a full re-render per tick is
 *  cheaper than diffing — but we skip it entirely when nothing changed, so an idle app
 *  does no DOM work between toasts. */
function render(): void {
	const parent = ensureHost();
	parent.textContent = '';

	for (const t of state.visible) {
		const el = document.createElement('div');
		el.className = `wcc-toast wcc-toast-${t.severity}`;
		const text = document.createElement('span');
		text.className = 'wcc-toast-msg';
		text.textContent = t.msg;
		el.appendChild(text);
		if (t.count > 1) {
			const n = document.createElement('span');
			n.className = 'wcc-toast-count';
			n.textContent = `×${t.count}`;
			el.appendChild(n);
		}
		if (t.action) {
			const btn = document.createElement('button');
			btn.className = 'wcc-toast-action';
			btn.textContent = t.action.label;
			const run = t.action.run;
			btn.addEventListener('click', (e) => {
				e.stopPropagation(); // the toast body's own handler would only dismiss it
				state = dismissToast(state, t.id, Date.now());
				render();
				try { run(); } catch { /* an action must never break the toast stack */ }
			});
			el.appendChild(btn);
		}
		el.title = 'Click to dismiss';
		el.addEventListener('click', () => { state = dismissToast(state, t.id, Date.now()); render(); });
		// Hovering holds the toast open: you moved the mouse there to read it, so the
		// countdown restarting each tick is the point.
		el.addEventListener('mouseenter', () => { hoveredId = t.id; });
		el.addEventListener('mouseleave', () => { if (hoveredId === t.id) hoveredId = null; });
		parent.appendChild(el);
	}

	const waiting = overflowCount(state);
	if (waiting > 0) {
		const pill = document.createElement('div');
		pill.className = 'wcc-toast-more';
		pill.textContent = `+${waiting} more`;
		parent.appendChild(pill);
	}
}

function stopClock(): void {
	if (timer !== null) { window.clearInterval(timer); timer = null; }
}

function startClock(): void {
	if (timer !== null) return;
	timer = window.setInterval(() => {
		const now = Date.now();
		if (hoveredId !== null) state = holdToast(state, hoveredId, now);
		const before = state;
		state = expireToasts(state, now);
		if (state !== before) render();
		if (state.visible.length === 0 && state.queued.length === 0) { stopClock(); render(); }
	}, TICK_MS);
}

/** Show a toast. `variant` picks the colour + how long it stays:
 *  `success` · `error` · `warn` · `info` (default), plus the attention aliases
 *  `done`/`help`/`input`. Anything past three stacks up behind a "+N more" pill.
 *
 *  `opts.action` adds one button (an Undo), and `opts.durationMs` gives it long enough to be
 *  clicked. Hovering holds the toast open, so a slow reader does not lose the offer. */
export function toast(msg: string, variant?: ToastVariant, opts?: ToastPushOptions): void {
	state = pushToast(state, msg, variant, Date.now(), opts);
	render();
	startClock();
}

/** Test/teardown hook: clear the stack and the clock. */
export function resetToasts(): void {
	stopClock();
	state = emptyToasts();
	hoveredId = null;
	host?.remove();
	host = null;
}
