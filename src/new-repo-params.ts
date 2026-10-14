import * as path from 'path';
import { repoDirName } from './create-repo';
import type { RemoteVisibility } from './gh-cli';

/** What a brand-new repo is instantiated WITH, beyond the name and the folder it goes in. Pure —
 *  the form that collects these and createGitRepo that applies them are the thin IO around it.
 *
 *  Each one is here because it is awkward to get right after the first commit, which is the
 *  commit every worktree on the floor branches from:
 *  - `branch`: the base every terminal's worktree is cut from. Renaming it later means
 *    re-pointing every open worktree. Defaults to `main`, which createGitRepo always used.
 *  - `gitignore`: in the first commit, so `node_modules/` or a `.env` never lands in history.
 *  - `claudeMd`: every terminal here is a Claude Code session, and its CLAUDE.md is what the
 *    first one reads. A seed that says what is missing beats an absent file nobody notices.
 *  - `remote`: a GitHub repo via `gh`, only offered when gh is installed (see gh-cli.ts). */
export type GitignoreKind = 'none' | 'general' | 'node' | 'python';
export type RemoteChoice = 'none' | RemoteVisibility;

export interface NewRepoParams {
	name: string;
	parentDir: string;
	branch: string;
	gitignore: GitignoreKind;
	claudeMd: boolean;
	remote: RemoteChoice;
}

export const GITIGNORE_KINDS: { id: GitignoreKind; label: string }[] = [
	{ id: 'general', label: 'General (.env, logs, OS junk)' },
	{ id: 'node', label: 'Node / TypeScript' },
	{ id: 'python', label: 'Python' },
	{ id: 'none', label: 'None' },
];

export function defaultNewRepoParams(name = '', parentDir = ''): NewRepoParams {
	return { name, parentDir, branch: 'main', gitignore: 'general', claudeMd: true, remote: 'none' };
}

/** The subset of `git check-ref-format` rules a person can plausibly trip over in a text box. */
export function validBranchName(b: string): boolean {
	if (!b || b !== b.trim()) return false;
	if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(b)) return false;
	if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
	if (b.includes('..') || b.includes('//') || b.includes('@{') || b === '@') return false;
	return !b.split('/').some((part) => part.startsWith('.'));
}

const OS_JUNK = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const GITIGNORES: Record<Exclude<GitignoreKind, 'none'>, string[]> = {
	general: ['.env', '.env.*', '*.log', ...OS_JUNK],
	node: ['node_modules/', 'dist/', 'build/', 'coverage/', '.env', '.env.*', '*.log', '*.tsbuildinfo', ...OS_JUNK],
	python: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '*.egg-info/', 'dist/', 'build/', '.pytest_cache/', '.mypy_cache/', '.env', ...OS_JUNK],
};

export function gitignoreFor(kind: GitignoreKind): string | null {
	return kind === 'none' ? null : GITIGNORES[kind].join('\n') + '\n';
}

export function claudeMdSeed(name: string): string {
	return [
		`# ${name.trim()}`,
		'',
		'Instructions for every Claude Code session that works in this repository.',
		'',
		'## Build and test',
		'',
		'_Not set up yet._ Add the commands a session must run before calling its work done.',
		'',
		'## Conventions',
		'',
		'_None recorded yet._',
		'',
	].join('\n');
}

/** Files to write before the initial commit, beyond the README createGitRepo always seeds. */
export function seedFiles(p: NewRepoParams): Record<string, string> {
	const out: Record<string, string> = {};
	const gi = gitignoreFor(p.gitignore);
	if (gi) out['.gitignore'] = gi;
	if (p.claudeMd) out['CLAUDE.md'] = claudeMdSeed(p.name);
	return out;
}

/** Why these params cannot be used, or null when they can. */
export function newRepoProblem(p: NewRepoParams, ghAvailable: boolean): string | null {
	if (!repoDirName(p.name)) return 'Enter a name with at least one letter or number.';
	if (!p.parentDir) return 'Choose a folder to create it in.';
	if (!validBranchName(p.branch)) return `"${p.branch}" is not a valid git branch name.`;
	if (p.remote !== 'none' && !ghAvailable) return 'A GitHub remote needs the GitHub CLI (gh), which was not found.';
	return null;
}

/** The confirm text: everything that will be written, and where, before anything is. Creating a
 *  repo writes outside the app's own data folder, so nothing about it should be a surprise. */
export function describeNewRepo(p: NewRepoParams): string {
	const dir = path.join(p.parentDir, repoDirName(p.name));
	const files = ['README.md', ...Object.keys(seedFiles(p))];
	const lines = [
		`Create a new folder:\n  ${dir}`,
		`git init on branch "${p.branch}", then an initial commit of: ${files.join(', ')}`,
	];
	if (p.remote !== 'none') lines.push(`Create a ${p.remote} GitHub repo "${repoDirName(p.name)}" with gh, add it as origin, and push.`);
	lines.push('The folder must not exist yet — nothing already on disk is touched.');
	return lines.join('\n\n');
}
