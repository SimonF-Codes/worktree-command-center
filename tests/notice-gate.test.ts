import { describe, it, expect } from 'vitest';
import {
	applyDraftChunk, emptyDraft, queueNotice, flushJoin, NoticeGate,
	MAX_QUEUED_NOTICES, RESYNC_QUIET_MS, type NoticeDeliveryKind,
} from '../src/terminals/notice-gate';

const WATCH = '[watch] terminal "api" finished — you asked: ping me when the tests pass';

describe('applyDraftChunk (the draft tracker)', () => {
	it('printable input grows the draft', () => {
		let d = emptyDraft();
		for (const ch of 'check the loader ') d = applyDraftChunk(d, ch, 1);
		expect(d.len).toBe('check the loader '.length);
	});
	it('backspace / delete shrink it, floored at zero', () => {
		expect(applyDraftChunk({ len: 2, lastInputAt: 0 }, '\x7f', 1).len).toBe(1);
		expect(applyDraftChunk({ len: 0, lastInputAt: 0 }, '\b', 1).len).toBe(0);
	});
	it('Enter submits: empty, and flagged as an unambiguous clear', () => {
		const d = applyDraftChunk({ len: 9, lastInputAt: 0 }, '\r', 1);
		expect(d.len).toBe(0);
		expect(d.cleared).toBe(true);
	});
	it('Ctrl+C, Ctrl+U and a bare Escape clear the box', () => {
		for (const key of ['\x03', '\x15', '\x1b']) {
			const d = applyDraftChunk({ len: 12, lastInputAt: 0 }, key, 1);
			expect(d.len).toBe(0);
			expect(d.cleared).toBe(true);
		}
	});
	it('arrow keys leave the length alone but still count as the user being at the keyboard', () => {
		const d = applyDraftChunk({ len: 4, lastInputAt: 0 }, '\x1b[A', 99);
		expect(d.len).toBe(4);
		expect(d.lastInputAt).toBe(99);
		expect(d.cleared).toBe(false);
	});
	it('a focus report is not the user — it changes nothing, not even the typing timestamp', () => {
		const d = applyDraftChunk({ len: 4, lastInputAt: 7 }, '\x1b[I', 99);
		expect(d).toEqual({ len: 4, lastInputAt: 7, cleared: false });
	});
	it('a bracketed paste is draft, not a submit — its newlines land in the box', () => {
		const d = applyDraftChunk(emptyDraft(), '\x1b[200~one\ntwo\x1b[201~', 1);
		expect(d.len).toBe('one\ntwo'.length);
		expect(d.cleared).toBe(false);
	});
	it('a paste arriving unbracketed is still a draft when the caller says it is pasting', () => {
		const d = applyDraftChunk(emptyDraft(), 'one\ntwo', 1, true);
		expect(d.len).toBe(7);
		expect(d.cleared).toBe(false);
	});
	it('Shift/Alt+Enter inserts a newline instead of submitting — the draft survives it', () => {
		expect(applyDraftChunk({ len: 5, lastInputAt: 0 }, '\n', 1).len).toBe(6);
		expect(applyDraftChunk({ len: 5, lastInputAt: 0 }, '\x1b\r', 1).len).toBe(5);
	});
});

describe('queueNotice (cap + coalesce, never drop)', () => {
	it('appends in arrival order', () => {
		expect(queueNotice(queueNotice([], 'a'), 'b')).toEqual(['a', 'b']);
	});
	it('coalesces an exact duplicate instead of queueing it twice', () => {
		expect(queueNotice(['a'], 'a')).toEqual(['a']);
	});
	it('past the cap it merges into the last entry rather than dropping anything', () => {
		const full = ['a', 'b'];
		const over = queueNotice(full, 'c', 2);
		expect(over.length).toBe(2);
		expect(flushJoin(over)).toBe('a\nb\nc');   // every notice still present
	});
	it('the default cap is a real number of entries', () => {
		expect(MAX_QUEUED_NOTICES).toBeGreaterThan(1);
	});
});

/** A stand-in for the PTY + the wiring around it: keystrokes are forwarded to the PTY first and
 *  only then fed to the gate, exactly as GodConsole/TerminalTile do it. */
function harness(opts: { now?: () => number } = {}) {
	const pty: string[] = [];
	const kinds: NoticeDeliveryKind[] = [];
	const badge: number[] = [];
	const gate = new NoticeGate({
		deliver: (text, kind) => { pty.push(text); kinds.push(kind); },
		onQueueChange: (n) => badge.push(n),
		now: opts.now,
	});
	const type = (s: string): void => { for (const ch of s) { pty.push(ch); gate.input(ch); } };
	const key = (k: string): void => { pty.push(k); gate.input(k); };
	return { pty, kinds, badge, gate, type, key };
}

describe('NoticeGate (the bug itself)', () => {
	it('a notice arriving mid-draft does NOT reach the PTY, and does once the draft clears', () => {
		const h = harness();
		h.type('check whether the loader ');
		h.gate.notify(WATCH);
		expect(h.pty.join('')).toBe('check whether the loader ');   // nothing injected into his sentence
		expect(h.gate.queued).toBe(1);

		h.key('\r');                                               // he submits his own line
		expect(h.pty.join('')).toBe(`check whether the loader \r${WATCH}`);
		expect(h.kinds).toEqual(['flush']);                        // released after his Enter, not merged into it
		expect(h.gate.queued).toBe(0);
	});

	it('an empty box still gets the notice immediately, exactly as before', () => {
		const h = harness();
		h.gate.notify(WATCH);
		expect(h.pty).toEqual([WATCH]);
		expect(h.kinds).toEqual(['immediate']);
	});

	it('nothing is dropped: every notice queued during a draft survives it, in order', () => {
		const h = harness();
		h.type('hmm');
		h.gate.notify('[watch] one');
		h.gate.notify('[error] two');
		h.gate.notify('[watch] one');            // duplicate coalesces
		expect(h.gate.pending).toEqual(['[watch] one', '[error] two']);
		expect(h.pty.join('')).toBe('hmm');

		h.key('\x15');                            // Ctrl+U clears his line
		expect(h.pty.join('')).toBe('hmm\x15[watch] one\n[error] two');
		expect(h.gate.queued).toBe(0);
	});

	it('backspacing the draft away releases the queue too', () => {
		const h = harness();
		h.type('ab');
		h.gate.notify(WATCH);
		h.key('\x7f');
		expect(h.pty.join('')).toBe('ab\x7f');    // still one char left
		h.key('\x7f');
		expect(h.pty.join('')).toBe(`ab\x7f\x7f${WATCH}`);
	});

	it('Enter on a box the tracker wrongly believes is occupied still releases the queue', () => {
		const h = harness();
		h.type('xy');                             // tracker says 2 chars…
		h.gate.notify(WATCH);
		// …but the TUI actually cleared it some way we could not see. His Enter is unambiguous.
		h.key('\r');
		expect(h.pty.join('')).toBe(`xy\r${WATCH}`);
	});

	it('the badge reports what is waiting, and that it went to zero on release', () => {
		const h = harness();
		h.type('a');
		h.gate.notify('[watch] one');
		h.gate.notify('[error] two');
		expect(h.badge).toEqual([1, 2]);
		h.key('\r');
		expect(h.badge).toEqual([1, 2, 0]);
	});

	it('flushNow delivers despite a live draft — the one path the user asks for explicitly', () => {
		const h = harness();
		h.type('mid sentence');
		h.gate.notify(WATCH);
		expect(h.pty.join('')).toBe('mid sentence');
		h.gate.flushNow();
		expect(h.pty.join('')).toBe(`mid sentence${WATCH}`);
	});
});

describe('NoticeGate.ready (the resync)', () => {
	it('resyncs a stale draft to empty and releases the queue', () => {
		let t = 1000;
		const h = harness({ now: () => t });
		h.type('ab');                             // tracker believes 2 chars are in the box
		h.gate.notify(WATCH);
		expect(h.gate.queued).toBe(1);
		t += RESYNC_QUIET_MS;                     // the keyboard has been quiet since
		h.gate.ready();
		expect(h.gate.drafting).toBe(false);
		expect(h.pty.join('')).toBe(`ab${WATCH}`);
	});

	it('does NOT resync over someone who is mid-sentence right now', () => {
		let t = 1000;
		const h = harness({ now: () => t });
		h.type('ab');
		h.gate.notify(WATCH);
		t += 100;                                 // a turn ends while he is still typing
		h.gate.ready();
		expect(h.gate.drafting).toBe(true);
		expect(h.gate.queued).toBe(1);
		expect(h.pty.join('')).toBe('ab');        // his draft is untouched
	});

	it('with an empty box it simply releases anything waiting (e.g. after a session restart)', () => {
		const h = harness();
		h.type('ab');
		h.gate.notify(WATCH);
		h.gate.reset();                           // session restarted: new TUI, empty box, queue kept
		expect(h.gate.queued).toBe(1);
		expect(h.pty.join('')).toBe('ab');        // reset alone never writes into a booting TUI
		h.gate.ready();
		expect(h.pty.join('')).toBe(`ab${WATCH}`);
	});
});
