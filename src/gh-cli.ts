import * as fs from 'fs';
import * as path from 'path';
import { resolveOnPath } from './resolve-on-path';
import { runCommand } from './command-runner';

export type RemoteVisibility = 'private' | 'public';

/** Where the GitHub CLI can live, in the order to try them. Pure.
 *
 *  PATH first, then the two Windows installs that do NOT put gh on PATH for an app that was
 *  already running when gh was installed (or ever, for a per-user winget install): winget's
 *  per-package folder `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe` —
 *  where it is on Simon's machine — and the MSI's `Program Files\GitHub CLI`. `packageDirs`
 *  is the listing of winget's Packages folder; newest-sorting names first is a tie-break for
 *  the rare machine with two sources installed. */
export function ghCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, packageDirs: string[]): string[] {
	if (platform !== 'win32') return [];
	const out: string[] = [];
	const local = env.LOCALAPPDATA;
	if (local) {
		for (const d of packageDirs.filter((n) => /^GitHub\.cli_/i.test(n)).sort().reverse()) {
			out.push(path.join(local, 'Microsoft', 'WinGet', 'Packages', d, 'bin', 'gh.exe'));
		}
	}
	for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (pf) out.push(path.join(pf, 'GitHub CLI', 'gh.exe'));
	return out;
}

/** Absolute path of a usable `gh`, or null. Never throws: an absent gh is a normal machine and
 *  the caller degrades (no remote offered) rather than failing. */
export function findGh(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
	const onPath = resolveOnPath('gh', env, platform);
	if (onPath) return onPath;
	let packageDirs: string[] = [];
	if (env.LOCALAPPDATA) {
		try { packageDirs = fs.readdirSync(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')); } catch { packageDirs = []; }
	}
	for (const c of ghCandidates(env, platform, packageDirs)) {
		try { if (fs.statSync(c).isFile()) return c; } catch { /* not here */ }
	}
	return null;
}

/** `gh repo create` arguments for an existing local repo: create the GitHub repo, add it as
 *  `origin`, and push the initial commit — so a worktree's branch has somewhere to go on day one. Pure. */
export function ghRepoCreateArgs(name: string, repoPath: string, visibility: RemoteVisibility): string[] {
	return ['repo', 'create', name, `--${visibility}`, '--source', repoPath, '--remote', 'origin', '--push'];
}

export interface RemoteResult { ok: boolean; url?: string; error?: string; }

/** Create the GitHub remote. Never throws; a failure (not logged in, name taken, offline) comes
 *  back as `ok: false` with gh's own first line of complaint, because the local repo is already
 *  made and fine — the remote is the part that can be retried by hand. */
export async function createGitHubRemote(gh: string, repoPath: string, name: string, visibility: RemoteVisibility): Promise<RemoteResult> {
	const r = await runCommand(gh, ghRepoCreateArgs(name, repoPath, visibility), { cwd: repoPath, timeoutMs: 60000 });
	if (r.code === 0) {
		const url = `${r.stdout}\n${r.stderr}`.match(/https:\/\/github\.com\/\S+/)?.[0];
		return { ok: true, ...(url ? { url } : {}) };
	}
	const why = (r.error ?? '') || r.stderr.split(/\r?\n/).find((l) => l.trim()) || `gh exited ${r.code}`;
	return { ok: false, error: why.trim() };
}
