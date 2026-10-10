// resume-target on a POSIX host, whatever host this suite actually runs on.
//
// The inputs are Windows paths (Claude writes them; this app runs on Windows), but CI runs on
// ubuntu. The module once derived a transcript's folder with `path.dirname`, which on POSIX does
// not split on `\` and returns "." — so no job transcript was ever recognised and the job won
// --continue again. That passed on every Windows dev machine and only failed in CI. Swapping the
// `path` module for its POSIX flavour here puts every host in CI's shoes: any path-flavour
// dependence in the module fails this file on Windows too.

import { describe, it, expect, vi } from 'vitest';

vi.mock('path', async () => {
	const actual = await vi.importActual<typeof import('path')>('path');
	return { ...actual.posix, default: actual.posix };
});

const { orphanTranscripts, pickResumeFile } = await import('../src/terminals/resume-target');

const PROJ = String.raw`C:\Users\fridl\.claude\projects\C--Users-fridl-AppData-Roaming-worktree-command-center--coordination--god-default`;
const file = (sessionId: string): string => `${PROJ}\\${sessionId}.jsonl`;

describe('resume-target with a POSIX path module', () => {
	it('the mock is in force: POSIX dirname cannot split a backslash path', async () => {
		// Guards the guard — if the mock silently stopped applying, the cases below would pass on
		// Windows for the wrong reason.
		const p = await import('path');
		expect(p.dirname(file('x'))).toBe('.');
	});

	it('still recognises a Windows-spelled job transcript in a Windows-spelled folder', () => {
		expect(orphanTranscripts([{ linkScanPath: file('job') }], PROJ).size).toBe(1);
	});

	it('still skips the job transcript and resumes the console', () => {
		const orphans = orphanTranscripts([{ linkScanPath: file('job') }], PROJ);
		expect(pickResumeFile([
			{ file: file('alpha'), mtimeMs: 1_000 },
			{ file: file('job'), mtimeMs: 1_008 },
		], orphans)).toBe(file('alpha'));
	});
});
