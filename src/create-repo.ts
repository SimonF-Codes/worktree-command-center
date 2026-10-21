import * as fs from 'fs';
import * as path from 'path';
import { runCommand } from './command-runner';

export interface CreateRepoResult {
	ok: boolean;
	path?: string;
	branch?: string;      // the base branch the repo was initialised on
	error?: string;
	committed: boolean;   // false if git init succeeded but the initial commit didn't (e.g. no git identity)
	commitError?: string; // git's last line of complaint when `committed` is false
}

/** Filesystem-safe directory name from a repo display name; '' if nothing usable remains. Pure. */
export function repoDirName(name: string): string {
	return name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Create a brand-new git repo under `parentDir`: mkdir, `git init`, seed a README, and make an
 *  initial commit so the repo has a base branch (worktrees — which this app spawns on — require
 *  at least one commit to branch from). Never throws. If the commit fails (typically no configured
 *  git user.name/email), the repo is still created + init'd and `committed: false` is returned so
 *  the caller can tell the user to finish setup.
 *
 *  `opts.branch` names the base branch (default `main`); `opts.files` are extra seed files
 *  (relative path → content, e.g. .gitignore, CLAUDE.md — see new-repo-params.ts) that go into
 *  the same initial commit. Both are optional, so the two-argument call is unchanged. The target
 *  folder must not exist, which is what keeps this from ever writing over anything. */
export async function createGitRepo(
	parentDir: string, name: string, opts: { branch?: string; files?: Record<string, string> } = {},
): Promise<CreateRepoResult> {
	const dir = repoDirName(name);
	if (!dir) return { ok: false, error: 'Please enter a name with at least one letter or number.', committed: false };
	const repoPath = path.join(parentDir, dir);
	if (fs.existsSync(repoPath)) return { ok: false, error: `"${dir}" already exists in that folder.`, committed: false };
	const branch = opts.branch?.trim() || 'main';

	try { fs.mkdirSync(repoPath, { recursive: true }); }
	catch (e) { return { ok: false, error: (e as Error).message, committed: false }; }

	// `git init -b <branch>`; on older gits that lack -b, plain `git init` and point HEAD at the
	// branch by hand — which also refuses a name git won't accept, rather than quietly using master.
	let init = await runCommand('git', ['init', '-b', branch], { cwd: repoPath, timeoutMs: 10000 });
	if (init.code !== 0) {
		init = await runCommand('git', ['init'], { cwd: repoPath, timeoutMs: 10000 });
		if (init.code === 0) init = await runCommand('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: repoPath, timeoutMs: 10000 });
	}
	if (init.code !== 0) return { ok: false, path: repoPath, error: (init.error ?? init.stderr).split('\n')[0] || 'git init failed', committed: false };

	try { fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${name.trim()}\n`, 'utf8'); } catch { /* non-fatal */ }
	for (const [rel, content] of Object.entries(opts.files ?? {})) {
		const target = path.resolve(repoPath, rel);
		// Seed files stay inside the new folder, whatever a caller passes.
		if (!target.startsWith(path.resolve(repoPath) + path.sep)) continue;
		try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, 'utf8'); } catch { /* non-fatal */ }
	}
	await runCommand('git', ['add', '-A'], { cwd: repoPath, timeoutMs: 10000 });
	const commit = await runCommand('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, timeoutMs: 10000 });
	if (commit.code === 0) return { ok: true, path: repoPath, branch, committed: true };
	const why = (commit.error ?? '') || `${commit.stderr}\n${commit.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
	return { ok: true, path: repoPath, branch, committed: false, ...(why ? { commitError: why } : {}) };
}
