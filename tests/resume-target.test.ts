import { describe, it, expect } from 'vitest';
import { projectDirName, normDir, orphanTranscripts, pickResumeFile, type Transcript } from '../src/terminals/resume-target';

/** Windows paths, spelled with String.raw so the backslashes stay backslashes. */
const PROJ = String.raw`C:\Users\fridl\.claude\projects\C--Users-fridl-AppData-Roaming-worktree-command-center--coordination--god-default`;
const file = (sessionId: string): string => `${PROJ}\\${sessionId}.jsonl`;
const t = (sessionId: string, mtimeMs: number): Transcript => ({ file: file(sessionId), mtimeMs });

// The two transcripts from the 2026-09-16 outage, with their real ids.
const ALPHA = '91b706d1-c45c-4c69-a133-68a1fda74d46';   // the console's own conversation
const JOB = '45d9196d-8a96-49f0-a27e-c1d8c46f7e61';     // the background job forked off it

describe('projectDirName', () => {
	it('matches the folders Claude Code actually writes', () => {
		// Sampled from a real ~/.claude/projects: every non-alphanumeric character becomes a
		// hyphen, so `:`, `\`, `.` and `_` all collapse the same way.
		expect(projectDirName(String.raw`C:\Users\fridl\AppData\Roaming\worktree-command-center\.coordination\.god\default`))
			.toBe('C--Users-fridl-AppData-Roaming-worktree-command-center--coordination--god-default');
		expect(projectDirName(String.raw`C:\dev\Brain_2.0`)).toBe('C--dev-Brain-2-0');
		expect(projectDirName(String.raw`C:\dev\.claude-worktrees\Brain_2.0\wt-master-1`))
			.toBe('C--dev--claude-worktrees-Brain-2-0-wt-master-1');
	});

	it('leaves hyphens that are already there', () => {
		expect(projectDirName(String.raw`C:\dev\worktree-command-center`)).toBe('C--dev-worktree-command-center');
	});
});

describe('normDir', () => {
	it('splits on either separator, so the host path flavour cannot matter', () => {
		// path.dirname on POSIX returns "." for the backslash spelling — the CI-only failure.
		expect(normDir(String.raw`a\b\c.jsonl`)).toBe('a/b');
		expect(normDir('a/b/c.jsonl')).toBe('a/b');
		expect(normDir(file(JOB))).toBe(PROJ.replace(/\\/g, '/').toLowerCase());
	});

	it('returns a bare name unchanged', () => {
		expect(normDir('c.jsonl')).toBe('c.jsonl');
	});
});

describe('orphanTranscripts', () => {
	it('claims the jobs writing into this project folder', () => {
		const jobs = [
			{ linkScanPath: file(JOB) },
			{ linkScanPath: String.raw`C:\Users\fridl\.claude\projects\C--dev-ChessEdu\abc.jsonl` },
		];
		expect([...orphanTranscripts(jobs, PROJ)]).toEqual([file(JOB).replace(/\\/g, '/').toLowerCase()]);
	});

	it('matches across separator and case differences', () => {
		// The job records a path Claude wrote; we compare it against one path.join built here.
		const jobs = [{ linkScanPath: `${PROJ.replace(/\\/g, '/').toLowerCase()}/a.jsonl` }];
		expect(orphanTranscripts(jobs, `${PROJ}\\`).size).toBe(1);
	});

	it('ignores a job with no transcript recorded yet', () => {
		expect(orphanTranscripts([{}], PROJ).size).toBe(0);
	});

	it('does not claim a SIBLING home — .god/default must not swallow .god/default-5', () => {
		expect(orphanTranscripts([{ linkScanPath: `${PROJ}-5\\x.jsonl` }], PROJ).size).toBe(0);
	});
});

describe('pickResumeFile', () => {
	it('skips the job transcript and takes the console own newest', () => {
		// The exact 2026-09-16 shape: the forked job wrote 8s after the real conversation, so bare
		// --continue reached for the job and the console came back dead.
		const orphans = orphanTranscripts([{ linkScanPath: file(JOB) }], PROJ);
		expect(pickResumeFile([t(ALPHA, 1_000), t(JOB, 1_008)], orphans)).toBe(file(ALPHA));
	});

	it('matches a job to its transcript despite the SHORT folder id', () => {
		// The trap: ~/.claude/jobs/45d9196d holds the session whose transcript is
		// 45d9196d-8a96-…jsonl. Keying orphans by the folder name matches nothing, so the job
		// stays eligible and the console resumes it anyway — the bug this fix exists to prevent.
		const orphans = orphanTranscripts([{ linkScanPath: file(JOB) }], PROJ);
		expect(orphans.has(`${PROJ}\\${JOB.slice(0, 8)}.jsonl`.replace(/\\/g, '/').toLowerCase())).toBe(false);
		expect(pickResumeFile([t(JOB, 2), t(ALPHA, 1)], orphans)).toBe(file(ALPHA));
	});

	it('takes the newest when nothing is a job', () => {
		expect(pickResumeFile([t('old', 1), t('new', 2)], new Set())).toBe(file('new'));
	});

	it('returns null when every transcript belongs to a job', () => {
		// Adopting a stranger's conversation would be worse than starting fresh.
		const orphans = orphanTranscripts([{ linkScanPath: file('a') }, { linkScanPath: file('b') }], PROJ);
		expect(pickResumeFile([t('a', 1), t('b', 2)], orphans)).toBeNull();
	});

	it('returns null for an empty folder', () => {
		expect(pickResumeFile([], new Set())).toBeNull();
	});
});
