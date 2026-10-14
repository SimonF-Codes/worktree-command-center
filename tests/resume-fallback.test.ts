import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ResumeProbe, shouldStartFresh, RESUME_FAIL_WINDOW_MS } from '../src/terminals/resume-fallback';

const LIVE = RESUME_FAIL_WINDOW_MS * 10; // a console that really came back, quit much later

describe('shouldStartFresh', () => {
	it('still catches the one message the old single string match caught', () => {
		expect(shouldStartFresh({ fallbackFresh: true, probe: 'No conversation found to continue', elapsedMs: LIVE })).toBe(true);
	});

	it('catches a transcript another live process already holds', () => {
		// The 2026-09-16 outage: a background job forked off the previous console still owned the
		// session, so --continue exited on a message the old regex did not know. The console sat
		// dead behind `[Alpha session ended]` and ⟳ re-ran the same doomed command.
		for (const probe of [
			'Error: session 45d9196d is already in use',
			'That conversation is in use by another client',
			'Failed to resume conversation',
		]) {
			expect(shouldStartFresh({ fallbackFresh: true, probe, elapsedMs: LIVE })).toBe(true);
		}
	});

	it('treats ANY exit inside the window as a launch that never got off the ground', () => {
		// The point of the window: wording we have never seen, and refusals that print nothing.
		expect(shouldStartFresh({ fallbackFresh: true, probe: '', elapsedMs: 0 })).toBe(true);
		expect(shouldStartFresh({ fallbackFresh: true, probe: 'something unrecognised', elapsedMs: RESUME_FAIL_WINDOW_MS - 1 })).toBe(true);
	});

	it('leaves a long-lived session that simply ended alone', () => {
		// /exit hours later is not a failed resume — relaunching there would fight the user.
		expect(shouldStartFresh({ fallbackFresh: true, probe: 'lots of normal TUI output', elapsedMs: LIVE })).toBe(false);
		expect(shouldStartFresh({ fallbackFresh: true, probe: '', elapsedMs: RESUME_FAIL_WINDOW_MS })).toBe(false);
	});

	it('never fires for a session that was already fresh, so the retry cannot loop', () => {
		// startSession(false) passes fallbackFresh: false. Without this, a machine with no claude
		// on PATH would relaunch forever.
		expect(shouldStartFresh({ fallbackFresh: false, probe: 'no conversation found to continue', elapsedMs: 0 })).toBe(false);
		expect(shouldStartFresh({ fallbackFresh: false, probe: '', elapsedMs: 0 })).toBe(false);
	});
});

describe('ResumeProbe', () => {
	// A duplicate overseer console (🜲+) launches `claude --continue` in a home dir claude has
	// never seen, so claude opens its workspace-trust dialog first. Only once someone answers it
	// does --continue find nothing and exit — seconds after launch, after kilobytes of dialog
	// paint. A probe that kept the FIRST bytes held only the dialog and the exit landed outside
	// the window, so the fresh fallback never fired: every duplicate sat dead behind
	// `[Alpha 6 session ended (code 1)]` before reaching its first turn.
	const captured = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trust-prompt-then-no-conversation.json'), 'utf8')) as { output: string }).output;
	const EXITED_AT_MS = 7972; // when that capture's claude exited: after the dialog, long past the window

	function feedInChunks(probe: ResumeProbe, text: string, size = 256): void {
		for (let i = 0; i < text.length; i += size) probe.feed(text.slice(i, i + size));
	}

	it('still sees the refusal when a trust dialog painted first (the overseer console\'s cap)', () => {
		const probe = new ResumeProbe(2048);
		feedInChunks(probe, captured);
		expect(shouldStartFresh({ fallbackFresh: true, probe: probe.text, elapsedMs: EXITED_AT_MS })).toBe(true);
	});

	it('keeps the refusal at the end of any prelude, at the worker tile\'s cap too', () => {
		expect(captured.length).toBeGreaterThan(4096); // the capture really is longer than both caps
		const probe = new ResumeProbe(4096);
		feedInChunks(probe, captured);
		expect(probe.text).toMatch(/no conversation found to continue/i);
	});

	it('stays bounded however long the session runs', () => {
		const probe = new ResumeProbe(100);
		feedInChunks(probe, 'x'.repeat(10_000), 7);
		expect(probe.text.length).toBeLessThanOrEqual(100);
	});
});
