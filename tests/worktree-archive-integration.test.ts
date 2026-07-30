/** End-to-end archive + revive against a REAL git repo and worktree.
 *
 *  The pure logic is covered in worktree-archive.test.ts; what matters here is the whole round
 *  trip: that only git-visible files are captured, that the folder is actually reclaimed, that the
 *  branch survives, and that a revive puts both the files and the Claude transcript back where
 *  `claude --continue` will find them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { runCommand } from '../src/command-runner';
import { archiveWorktree, reviveArchive, listArchives, readArchiveSummary, deleteArchive } from '../src/terminals/worktree-archive';
import { projectDirFor } from '../src/terminals/conversation-archive';
import { listZipNames } from '../src/terminals/zip-reader';

const git = (cwd: string, ...args: string[]) => runCommand('git', args, { cwd, timeoutMs: 30_000 });

let root = '';
let repoPath = '';
let worktreePath = '';
let archiveDir = '';
let home = '';
const BRANCH = 'wt/main-1';

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'wcc-arch-'));
	repoPath = path.join(root, 'repo');
	worktreePath = path.join(root, 'worktrees', 'wt-main-1');
	archiveDir = path.join(root, 'archives');
	home = path.join(root, 'home');

	await fs.mkdir(repoPath, { recursive: true });
	await git(repoPath, 'init', '-b', 'main');
	await git(repoPath, 'config', 'user.email', 'test@example.com');
	await git(repoPath, 'config', 'user.name', 'Test');
	await git(repoPath, 'config', 'commit.gpgsign', 'false');
	await fs.writeFile(path.join(repoPath, 'README.md'), '# base\n', 'utf8');
	await fs.writeFile(path.join(repoPath, '.gitignore'), 'node_modules/\n', 'utf8');
	await git(repoPath, 'add', '-A');
	await git(repoPath, 'commit', '-m', 'initial', '--no-verify');

	await git(repoPath, 'worktree', 'add', worktreePath, '-b', BRANCH, 'main');

	// A committed change, an uncommitted change, and bulk ignored junk that must NOT be archived.
	await fs.writeFile(path.join(worktreePath, 'committed.ts'), 'export const committed = 1;\n', 'utf8');
	await git(worktreePath, 'add', '-A');
	await git(worktreePath, 'commit', '-m', 'real work', '--no-verify');
	await fs.writeFile(path.join(worktreePath, 'dirty.ts'), 'export const dirty = 2;\n', 'utf8');
	await fs.mkdir(path.join(worktreePath, 'node_modules', 'junk'), { recursive: true });
	await fs.writeFile(path.join(worktreePath, 'node_modules', 'junk', 'big.js'), 'x'.repeat(200_000), 'utf8');

	// A fake Claude transcript for this worktree's CWD, in our fake home.
	const projDir = projectDirFor(worktreePath, home);
	await fs.mkdir(path.join(projDir, 'sess-1', 'tool-results'), { recursive: true });
	await fs.writeFile(path.join(projDir, 'sess-1.jsonl'), [
		JSON.stringify({ type: 'user', timestamp: '2026-07-20T10:00:00Z', sessionId: 'sess-1', message: { role: 'user', content: 'Make the archive sweep work' } }),
		JSON.stringify({ type: 'assistant', timestamp: '2026-07-20T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
	].join('\n') + '\n', 'utf8');
	await fs.writeFile(path.join(projDir, 'sess-1', 'tool-results', 'r1.txt'), 'tool output\n', 'utf8');
});

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('archiveWorktree (real repo)', () => {
	it('zips the work + conversation, reclaims the folder, and keeps the branch', async () => {
		const res = await archiveWorktree(
			{ repoName: 'repo', repoPath, branch: BRANCH, baseBranch: 'main', worktreePath, terminalName: 'main-1' },
			archiveDir, { reason: 'manual', home },
		);
		expect(res.error).toBeUndefined();
		expect(res.ok).toBe(true);
		const m = res.manifest!;

		// The three sidecar files exist, and the manifest describes the conversation.
		for (const ext of ['.zip', '.json', '.md']) {
			await expect(fs.access(path.join(archiveDir, `${m.base}${ext}`))).resolves.toBeUndefined();
		}
		expect(m.parked).toBe(true); // dirty.ts was uncommitted, so it was parked first
		expect(m.conversations).toHaveLength(1);
		expect(m.conversations[0]!.title).toBe('Make the archive sweep work');

		// Contents: git-visible files + the transcript, and NOT node_modules or .git.
		const names = listZipNames(await fs.readFile(path.join(archiveDir, `${m.base}.zip`)));
		expect(names).toContain('worktree/committed.ts');
		expect(names).toContain('worktree/dirty.ts');
		expect(names).toContain('ARCHIVE.md');
		expect(names).toContain('manifest.json');
		expect(names.some((n) => n.includes('sess-1.jsonl'))).toBe(true);
		expect(names.some((n) => n.includes('node_modules'))).toBe(false);
		expect(names.some((n) => n.startsWith('worktree/.git/'))).toBe(false); // the git dir itself
		expect(names).toContain('worktree/.gitignore');                        // …but tracked dotfiles stay

		// The 200 KB of ignored junk is why the zip is tiny.
		expect(m.zipBytes).toBeLessThan(20_000);

		// The folder is gone (space reclaimed) and so is the transcript dir…
		await expect(fs.access(worktreePath)).rejects.toThrow();
		await expect(fs.access(projectDirFor(worktreePath, home))).rejects.toThrow();
		// …but the branch and its commits are still in the repo.
		expect((await git(repoPath, 'rev-parse', '--verify', `refs/heads/${BRANCH}`)).code).toBe(0);

		// The summary is readable straight off disk — no inflation needed to browse.
		const summary = await readArchiveSummary(archiveDir, m.base);
		expect(summary).toContain('Make the archive sweep work');
		expect(summary).toContain(BRANCH);
	});

	it('lists the archive', async () => {
		const list = await listArchives(archiveDir);
		expect(list).toHaveLength(1);
		expect(list[0]!.branch).toBe(BRANCH);
	});

	it('refuses to archive a worktree whose folder is already gone', async () => {
		const res = await archiveWorktree(
			{ repoName: 'repo', repoPath, branch: BRANCH, baseBranch: 'main', worktreePath, terminalName: '' },
			archiveDir, { home },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/already gone/);
	});
});

describe('reviveArchive (real repo)', () => {
	it('restores the worktree at its original path, its files, and its transcript', async () => {
		const m = (await listArchives(archiveDir))[0]!;
		const res = await reviveArchive(m, archiveDir, { home });
		expect(res.error).toBeUndefined();
		expect(res.ok).toBe(true);
		expect(res.warning).toBeUndefined(); // branch survived, so no caveat
		expect(res.restored!.conversationRestored).toBe(true);
		// The SAME path — that's what makes `claude --continue` match the restored transcript.
		expect(path.resolve(res.restored!.worktreePath)).toBe(path.resolve(worktreePath));

		expect(await fs.readFile(path.join(worktreePath, 'committed.ts'), 'utf8')).toContain('committed');
		expect(await fs.readFile(path.join(worktreePath, 'dirty.ts'), 'utf8')).toContain('dirty');
		const projDir = projectDirFor(worktreePath, home);
		expect(await fs.readFile(path.join(projDir, 'sess-1.jsonl'), 'utf8')).toContain('Make the archive sweep work');
		expect(await fs.readFile(path.join(projDir, 'sess-1', 'tool-results', 'r1.txt'), 'utf8')).toContain('tool output');
	});

	it('refuses to revive over an occupied path instead of clobbering it', async () => {
		const m = (await listArchives(archiveDir))[0]!;
		const res = await reviveArchive(m, archiveDir, { home });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/already exists/);
	});

	it('deleteArchive removes all three files', async () => {
		const m = (await listArchives(archiveDir))[0]!;
		await deleteArchive(archiveDir, m.base);
		expect(await listArchives(archiveDir)).toHaveLength(0);
		for (const ext of ['.zip', '.json', '.md']) {
			await expect(fs.access(path.join(archiveDir, `${m.base}${ext}`))).rejects.toThrow();
		}
	});
});
