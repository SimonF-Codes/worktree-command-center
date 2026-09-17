import { describe, it, expect } from 'vitest';
import { shouldStartFresh, RESUME_FAIL_WINDOW_MS } from '../src/terminals/resume-fallback';

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
