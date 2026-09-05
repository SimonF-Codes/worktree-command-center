import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadRolePrompt } from '../src/terminals/role-loader';

/** A throwaway role library on disk. The wrapper is thin but it is the half that has to survive
 *  a missing folder and an unreadable file, which is exactly what cannot be tested purely. */
let dir = '';
let logs: string[] = [];
let warns: string[] = [];

function write(name: string, text: string): void {
	fs.writeFileSync(path.join(dir, name), text, 'utf8');
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-roles-'));
	logs = []; warns = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
	vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
});

afterEach(() => {
	vi.restoreAllMocks();
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const active = '---\ntype: reference\nrole: worker-terminal\nstatus: active\n---\n\nDo the work in your own worktree.\n';

describe('loadRolePrompt', () => {
	it('returns the role body plus a Session facts block', () => {
		write('Worker Terminal.md', active);
		const p = loadRolePrompt(dir, 'worker-terminal', [{ label: 'repo', value: 'app' }, { label: 'branch', value: 'wt/main-1' }]);
		expect(p).toBe('Do the work in your own worktree.\n\n---\n\n## Session facts\n\n- repo: app\n- branch: wt/main-1\n');
	});

	it('finds the role by slug even though the filename says something else', () => {
		write('Anything At All.md', active);
		expect(loadRolePrompt(dir, 'worker-terminal', [])).toContain('Do the work in your own worktree.');
	});

	it('logs the slug and that it came from the vault, naming the file', () => {
		write('Worker Terminal.md', active);
		loadRolePrompt(dir, 'worker-terminal', []);
		expect(logs.join('\n')).toContain('[roles] worker-terminal — vault (Worker Terminal.md)');
	});

	it('returns null with no library configured, and says so without warning', () => {
		expect(loadRolePrompt(undefined, 'alpha', [])).toBeNull();
		expect(logs.join('\n')).toContain('[roles] alpha — built-in (no roleLibrary configured)');
		expect(warns).toEqual([]);
	});

	it('returns null and warns when the configured folder does not exist', () => {
		expect(loadRolePrompt(path.join(dir, 'nope'), 'alpha', [])).toBeNull();
		expect(warns.join('\n')).toContain('[roles] alpha — built-in (role library unreadable');
	});

	it('returns null when the folder holds no file with that slug', () => {
		write('Worker Terminal.md', active);
		expect(loadRolePrompt(dir, 'alpha', [])).toBeNull();
		expect(warns.join('\n')).toContain('no role file declares role: alpha');
	});

	it('returns null for a role that is not active', () => {
		write('Draft.md', '---\nrole: alpha\nstatus: proposed\n---\nbody');
		expect(loadRolePrompt(dir, 'alpha', [])).toBeNull();
		expect(warns.join('\n')).toContain('not active');
	});

	it('ignores non-markdown files and unparseable ones', () => {
		write('notes.txt', '---\nrole: worker-terminal\nstatus: active\n---\nwrong file');
		write('README.md', '# not a role file');
		write('Worker.md', active);
		expect(loadRolePrompt(dir, 'worker-terminal', [])).toContain('Do the work in your own worktree.');
	});

	it('warns about a duplicate slug but still returns the last file wins', () => {
		write('A.md', '---\nrole: alpha\nstatus: active\n---\nfrom A');
		write('B.md', '---\nrole: alpha\nstatus: active\n---\nfrom B');
		expect(loadRolePrompt(dir, 'alpha', [])).toContain('from B');
		expect(warns.join('\n')).toContain('duplicate role slug(s)');
	});

	it('never throws on an entry that cannot be read — the rest of the library still loads', () => {
		write('Worker.md', active);
		// A directory called *.md reads exactly like the failure this has to survive: listed by
		// readdir, then throwing on read. A stalled OneDrive placeholder throws in the same place.
		fs.mkdirSync(path.join(dir, 'Broken.md'));
		expect(loadRolePrompt(dir, 'worker-terminal', [])).toContain('Do the work in your own worktree.');
		expect(loadRolePrompt(dir, 'alpha', [])).toBeNull();
	});
});
