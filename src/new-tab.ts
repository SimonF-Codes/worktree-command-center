import * as path from 'path';
import type { RepoConfig } from './terminals/terminals-grid';
import { repoDirName } from './create-repo';
import {
	defaultNewRepoParams, newRepoProblem, validBranchName, GITIGNORE_KINDS,
	type NewRepoParams, type GitignoreKind, type RemoteChoice,
} from './new-repo-params';

/** Pure decisions behind `new-tab`: a session (Kane through `cos-coord new-tab`, or an outside
 *  caller through the connector channel's `new-tab` request) asks the app for a workspace tab
 *  that is already bound to a repo — an existing registered target when it names one, a freshly
 *  instantiated repo when it does not. The IO lives in instantiate-repo.ts and app.ts; the field
 *  set and every refusal live here so both channels, and the 🆕 form, refuse the same things in
 *  the same order. Reference: docs/api.md, "new-tab". */

export const REMOTE_CHOICES: readonly RemoteChoice[] = ['none', 'private', 'public'];
export const MAX_TAB_NAME_LEN = 80;

/** The request's fields, as both channels carry them. Optional fields are null, never absent. */
export interface NewTabFields {
	/** The tab's display name. */
	name: string;
	/** An existing registered target to bind to. Excludes every new-repo field below. */
	repo: string | null;
	/** The repo to create. Null (with `repo` also null) means "create one named after the tab". */
	newRepo: string | null;
	parent: string | null;
	base: string | null;
	gitignore: GitignoreKind | null;
	claudeMd: boolean | null;
	remote: RemoteChoice | null;
}

export type FieldsResult = { ok: true; fields: NewTabFields } | { ok: false; reason: string };

const NEW_REPO_ONLY = ['parent', 'base', 'gitignore', 'claudeMd', 'remote'] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Validate a request body's new-tab fields. Checks run in the order docs/api.md lists them. */
export function parseNewTabFields(o: Record<string, unknown>): FieldsResult {
	const name = str(o.name);
	if (!name) return { ok: false, reason: 'malformed new-tab request — "name" (the tab name) is required' };
	if (name.length > MAX_TAB_NAME_LEN) return { ok: false, reason: `tab name is too long (${name.length} chars, max ${MAX_TAB_NAME_LEN})` };
	const repo = str(o.repo);
	const newRepo = str(o.newRepo);
	if (repo && newRepo) return { ok: false, reason: '"repo" and "newRepo" are mutually exclusive — name an existing target or a repo to create, not both' };
	if (repo) {
		// A creation parameter beside an existing target would be silently ignored — say so instead.
		const stray = NEW_REPO_ONLY.find((k) => o[k] !== undefined && o[k] !== null);
		if (stray) return { ok: false, reason: `"${stray}" only applies when creating a repo — it was sent with "repo" (an existing target)` };
	}
	const gitignore = str(o.gitignore);
	if (gitignore && !GITIGNORE_KINDS.some((k) => k.id === gitignore)) {
		return { ok: false, reason: `invalid gitignore "${gitignore}". Valid: ${GITIGNORE_KINDS.map((k) => k.id).join(', ')}` };
	}
	const remote = str(o.remote);
	if (remote && !(REMOTE_CHOICES as readonly string[]).includes(remote)) {
		return { ok: false, reason: `invalid remote "${remote}". Valid: ${REMOTE_CHOICES.join(', ')}` };
	}
	if (o.claudeMd !== undefined && o.claudeMd !== null && typeof o.claudeMd !== 'boolean') {
		return { ok: false, reason: '"claudeMd" must be true, false or null' };
	}
	const parent = str(o.parent);
	if (parent && !path.isAbsolute(parent)) return { ok: false, reason: `parent "${parent}" is not an absolute path` };
	const base = str(o.base);
	if (base && !validBranchName(base)) return { ok: false, reason: `"${base}" is not a valid git branch name` };
	if (!repo && !repoDirName(newRepo ?? name)) {
		return { ok: false, reason: newRepo
			? `repo name "${newRepo}" has no letter or number to make a folder name from`
			: `tab name "${name}" has no letter or number to name a new repo after — pass "newRepo"` };
	}
	return {
		ok: true,
		fields: {
			name, repo, newRepo, parent, base,
			gitignore: gitignore as GitignoreKind | null,
			claudeMd: typeof o.claudeMd === 'boolean' ? o.claudeMd : null,
			remote: remote as RemoteChoice | null,
		},
	};
}

/** What is at a path, as far as "may a repo be created here" needs to know. */
export type PathKind = 'missing' | 'empty' | 'nonempty' | 'file';

export interface NewRepoFacts {
	/** Every registered target, all tabs — a name is unique across the floor, not per tab. */
	repos: RepoConfig[];
	pathKind: (p: string) => PathKind;
}

/** Why a repo cannot be created where `p` says, or null. Shared by the 🆕 form and `new-tab`, so
 *  the two refuse the same things: a name already on the floor, a parent that is not there, and
 *  a target folder that exists at all — empty or not, never written into. */
export function newRepoRefusal(p: NewRepoParams, facts: NewRepoFacts): string | null {
	const dir = repoDirName(p.name);
	const taken = facts.repos.find((r) => r.name.toLowerCase() === dir.toLowerCase());
	if (taken) return `a target named "${taken.name}" is already registered (${taken.path}) — two checkouts cannot both own one name; pick another name, or use the existing target`;
	const parent = facts.pathKind(p.parentDir);
	if (parent === 'missing') return `parent folder ${p.parentDir} does not exist — create it first; a new repo never creates the folders above it`;
	if (parent === 'file') return `parent ${p.parentDir} is a file, not a folder`;
	const target = path.join(p.parentDir, dir);
	const kind = facts.pathKind(target);
	if (kind === 'nonempty') return `${target} already exists and has content — a new repo is never written into an existing folder`;
	if (kind === 'empty') return `${target} already exists (empty) — a new repo only goes in a folder that is not there yet; remove it or pick another name`;
	if (kind === 'file') return `${target} already exists as a file`;
	return null;
}

export interface NewTabFacts extends NewRepoFacts {
	/** Where the 🆕 form would propose putting a repo (tab-repo.ts defaultNewRepoParent). */
	defaultParent: string;
	ghAvailable: boolean;
}

/** Said whenever a remote was asked for and gh was not found. gh-cli.ts findGh looks in all three. */
export const GH_MISSING_WARNING =
	'no GitHub remote: the GitHub CLI (gh) was not found on PATH, under %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\GitHub.cli_*\\bin, or in Program Files\\GitHub CLI — the repo was created locally; add a remote later with `gh repo create`';

export type NewTabPlan =
	| { ok: false; reason: string }
	| { ok: true; kind: 'existing'; repo: RepoConfig }
	| { ok: true; kind: 'new'; params: NewRepoParams; warnings: string[] };

/** Decide what a validated new-tab request would do, against the floor as it is now. */
export function planNewTab(f: NewTabFields, facts: NewTabFacts): NewTabPlan {
	if (f.repo) {
		const want = f.repo.toLowerCase();
		const exact = facts.repos.filter((r) => r.name === f.repo);
		const hits = exact.length ? exact : facts.repos.filter((r) => r.name.toLowerCase() === want);
		if (!hits.length) return { ok: false, reason: `unknown repo "${f.repo}". Known: ${facts.repos.map((r) => r.name).join(', ') || '(none)'}` };
		if (hits.length > 1) {
			return { ok: false, reason: `"${f.repo}" is ambiguous — ${hits.length} registered targets share that name (${hits.map((r) => r.path).join(', ')}). Two checkouts cannot both own one name: forget or repoint one in Settings → Targets first` };
		}
		const repo = hits[0]!;
		if (repo.group) return { ok: false, reason: `"${repo.name}" belongs to the tab "${repo.group}" — a target grouped to one tab cannot be linked to another` };
		if (facts.pathKind(repo.path) === 'missing') return { ok: false, reason: `"${repo.name}" is registered at ${repo.path}, but that folder no longer exists — repoint or forget it in Settings → Targets` };
		return { ok: true, kind: 'existing', repo };
	}
	const parentDir = f.parent ?? facts.defaultParent;
	if (!parentDir) return { ok: false, reason: 'no parent folder — pass "parent"; no repo is registered yet to put a new one beside' };
	const defaults = defaultNewRepoParams(f.newRepo ?? f.name, parentDir);
	const warnings: string[] = [];
	let remote = f.remote ?? defaults.remote;
	// Degrade, never fail: the local repo is the part that matters, the remote can follow by hand.
	if (remote !== 'none' && !facts.ghAvailable) { warnings.push(GH_MISSING_WARNING); remote = 'none'; }
	const params: NewRepoParams = {
		...defaults,
		branch: f.base ?? defaults.branch,
		gitignore: f.gitignore ?? defaults.gitignore,
		claudeMd: f.claudeMd ?? defaults.claudeMd,
		remote,
	};
	const refusal = newRepoRefusal(params, facts) ?? newRepoProblem(params, facts.ghAvailable);
	if (refusal) return { ok: false, reason: refusal };
	return { ok: true, kind: 'new', params, warnings };
}

/** What git says when it cannot tell who is committing. `git var GIT_AUTHOR_IDENT` and
 *  `git commit` share the rule, so the probe and the commit agree. */
export function isMissingIdentity(gitOutput: string): boolean {
	return /please tell me who you are|identity unknown|unable to auto-detect email|auto-detection is disabled|empty ident name/i.test(gitOutput);
}

export const NO_IDENTITY_REASON =
	'git has no identity (user.name / user.email), so the initial commit would fail and no worktree could branch from the repo — nothing was created. Fix: git config --global user.name "Your Name" && git config --global user.email "you@example.com"';

/** The refusal when the folder was made but its initial commit was not. Loud on purpose: a repo
 *  with no commit has nothing to branch from, so every terminal on it would fail to start. */
export function uncommittedReason(repoPath: string, repoName: string, tabName: string, gitLine: string | undefined): string {
	return `created ${repoPath}, but its initial commit failed${gitLine ? ` (${gitLine})` : ''} — a worktree cannot branch from a repo with no commits, so no tab was made. It is registered as "${repoName}". Fix the cause (usually: git config --global user.name / user.email), commit in ${repoPath}, then: new-tab "${tabName}" --repo ${repoName}`;
}

/** What a session gets back for a tab that was made. */
export interface NewTabResult {
	workspaceId: string;
	tab: string;
	repo: string;
	repoPath: string;
	/** The branch the tab's toolbar opens on — the new repo's base, or null for an existing one. */
	branch: string | null;
	/** True when a repo was instantiated, false when the tab was bound to an existing target. */
	created: boolean;
	/** The new tab's coordination directory: `COS_COORD_DIR=<this> cos-coord spawn …` starts a
	 *  terminal in it, and `wcc-client --workspace <workspaceId>` reaches it from outside. */
	coordDir: string;
	remoteUrl: string | null;
	warnings: string[];
}

export type NewTabOutcome =
	| { ok: true; result: NewTabResult }
	/** `leftOnDisk` names a folder that WAS created though the request failed (no initial commit). */
	| { ok: false; reason: string; leftOnDisk?: string };

/** The one line a CLI prints on success, and the toast the app shows for a session-made tab. */
export function newTabSummary(r: NewTabResult, by?: string): string {
	const what = r.created ? `a new repo ${r.repo} (${r.repoPath}, branch ${r.branch})` : `${r.repo} (${r.repoPath})`;
	return `${by ? `${by} opened` : 'opened'} tab "${r.tab}" on ${what}${r.remoteUrl ? ` — remote ${r.remoteUrl}` : ''}`;
}
