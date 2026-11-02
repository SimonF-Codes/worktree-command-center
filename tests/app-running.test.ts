import { describe, it, expect } from 'vitest';
import { csvHasImage, isImageRunning } from '../scripts/app-running.mjs';

const EXE = 'Worktree Command Center.exe';

// Real output captured on Windows 11 while the app was running.
const TABLE = '\r\nImage Name                     PID Session Name        Session#    Mem Usage\r\n'
	+ '========================= ======== ================ =========== ============\r\n'
	+ 'Worktree Command Center.e    46600 Console                    1    104,900 K\r\n';
const CSV = '"Worktree Command Center.exe","46600","Console","1","104,868 K"\r\n'
	+ '"Worktree Command Center.exe","8804","Console","1","134,656 K"\r\n';
const NONE = 'INFO: No tasks are running which match the specified criteria.\r\n';

describe('csvHasImage', () => {
	it('finds the image in CSV output', () => expect(csvHasImage(CSV, EXE)).toBe(true));
	it('is case-insensitive, as Windows image names are', () => expect(csvHasImage(CSV, EXE.toUpperCase())).toBe(true));
	it('reads the no-match INFO line as not running', () => expect(csvHasImage(NONE, EXE)).toBe(false));
	it('does not match a different image that shares a prefix', () =>
		expect(csvHasImage('"Worktree Command Center Helper.exe","1","Console","1","1 K"\r\n', EXE)).toBe(false));
	it('documents why the table format is not used: its name column is truncated', () => {
		expect(TABLE.includes(EXE)).toBe(false);
	});
});

describe('isImageRunning', () => {
	it('asks tasklist for CSV with no header', () => {
		let args: string[] = [];
		isImageRunning(EXE, (_cmd: string, a: string[]) => { args = a; return { status: 0, stdout: CSV }; });
		expect(args).toEqual(['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH']);
	});
	it('true when the image is listed', () =>
		expect(isImageRunning(EXE, () => ({ status: 0, stdout: CSV }))).toBe(true));
	it('false when tasklist reports no match', () =>
		expect(isImageRunning(EXE, () => ({ status: 0, stdout: NONE }))).toBe(false));
	it('fails closed when tasklist cannot run', () =>
		expect(isImageRunning(EXE, () => ({ status: null, error: new Error('ENOENT'), stdout: '' }))).toBe(true));
});
