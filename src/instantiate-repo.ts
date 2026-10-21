import * as fs from 'fs';
import { runCommand } from './command-runner';
import { createGitRepo, repoDirName, type CreateRepoResult } from './create-repo';
import { createGitHubRemote } from './gh-cli';
import { seedFiles, type NewRepoParams } from './new-repo-params';
import { isMissingIdentity, NO_IDENTITY_REASON, GH_MISSING_WARNING, type PathKind } from './new-tab';

/** The thin IO around making a repo from a NewRepoParams: probe git's identity, createGitRepo,
 *  then the optional GitHub remote. The 🆕 form (app.ts createRepoInteractive) and a session's
 *  `new-tab` both come through here, so they cannot drift on what "a new repo" means. */

/** What is at `p`. Never throws: anything unreadable counts as content, which refuses. */
export function pathKind(p: string): PathKind {
	let st: fs.Stats;
	try { st = fs.statSync(p); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'nonempty'; }
	if (!st.isDirectory()) return 'file';
	try { return fs.readdirSync(p).length ? 'nonempty' : 'empty'; } catch { return 'nonempty'; }
}

export type IdentityVerdict = 'ok' | 'missing' | 'unknown';

/** Pure. A missing identity outside any repo is only conclusive when git has no conditional
 *  includes: an `includeIf "gitdir:…"` can supply user.name inside the new repo that a probe run
 *  in its parent folder cannot see. Then the probe says "unknown" and the commit decides. */
export function identityVerdict(probes: { code: number | null; output: string }[], hasConditionalIncludes: boolean): IdentityVerdict {
	const missing = probes.some((p) => p.code !== 0 && isMissingIdentity(p.output));
	if (!missing) return 'ok';
	return hasConditionalIncludes ? 'unknown' : 'missing';
}

/** Ask git, from the folder the repo will go in, whether it knows who is committing. */
export async function probeGitIdentity(cwd: string): Promise<IdentityVerdict> {
	const probes = await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map(async (v) => {
		const r = await runCommand('git', ['var', v], { cwd, timeoutMs: 10000 });
		return { code: r.code, output: `${r.stderr}\n${r.error ?? ''}` };
	}));
	if (identityVerdict(probes, false) === 'ok') return 'ok';
	const inc = await runCommand('git', ['config', '--get-regexp', '^includeif\\.'], { cwd, timeoutMs: 10000 });
	return identityVerdict(probes, inc.code === 0 && inc.stdout.trim() !== '');
}

export type RemoteOutcome =
	| { state: 'none' }                 // not asked for
	| { state: 'no-gh' }                // asked for, gh not found: skipped
	| { state: 'no-commit' }            // asked for, nothing to push: skipped
	| { state: 'created'; url?: string }
	| { state: 'failed'; error: string };

export interface RepoInstantiation extends CreateRepoResult { remote: RemoteOutcome; }

/** The warning a session or a toast carries for a remote that was asked for and did not happen.
 *  Pure; null when there is nothing to warn about. */
export function remoteWarning(remote: RemoteOutcome): string | null {
	if (remote.state === 'no-gh') return GH_MISSING_WARNING;
	if (remote.state === 'failed') return `the GitHub remote failed: ${remote.error}. The local repo is fine — add a remote later with \`gh repo create\``;
	if (remote.state === 'no-commit') return 'the GitHub remote was skipped: there was no commit to push';
	return null;
}

/** Make the repo. Never throws. Refuses before writing anything when git plainly has no
 *  identity; otherwise any failure after the folder exists comes back with `path` set. */
export async function instantiateRepo(
	params: NewRepoParams, gh: string | null, hooks: { onRemoteStart?: () => void } = {},
): Promise<RepoInstantiation> {
	if (await probeGitIdentity(params.parentDir) === 'missing') {
		return { ok: false, error: NO_IDENTITY_REASON, committed: false, remote: { state: 'none' } };
	}
	const res = await createGitRepo(params.parentDir, params.name, { branch: params.branch, files: seedFiles(params) });
	const wanted = params.remote !== 'none';
	if (!res.ok || !res.path) return { ...res, remote: { state: 'none' } };
	if (!res.committed) return { ...res, remote: { state: wanted ? 'no-commit' : 'none' } };
	if (!wanted || params.remote === 'none') return { ...res, remote: { state: 'none' } };
	if (!gh) return { ...res, remote: { state: 'no-gh' } };
	hooks.onRemoteStart?.();
	const rr = await createGitHubRemote(gh, res.path, repoDirName(params.name), params.remote);
	return { ...res, remote: rr.ok ? { state: 'created', ...(rr.url ? { url: rr.url } : {}) } : { state: 'failed', error: rr.error ?? 'gh failed' } };
}
