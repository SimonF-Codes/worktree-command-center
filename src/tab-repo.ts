import * as path from 'path';
import type { RepoConfig } from './terminals/terminals-grid';
import type { ToolbarState } from './terminals/toolbar-state';
import type { Workspace } from './terminals/workspace-store';
import { linkedRepo } from './workspace';

/** Pure decisions behind "a new tab is born linked to a repo". The dialogs and the git calls
 *  that act on them live in app.ts and ui/new-repo-dialog.ts. */

export type TabLinkKind = 'new' | 'existing' | 'browse' | 'none';

/** The first question a new tab asks. A new repo leads, because "start a new project here" is
 *  what this exists for; "no repo" stays last and is still a legitimate answer, which is how
 *  every tab worked before. "Existing" only appears when there is something to pick from. */
export function tabLinkOptions(registered: number): { id: TabLinkKind; label: string; sublabel: string }[] {
	const out: { id: TabLinkKind; label: string; sublabel: string }[] = [
		{ id: 'new', label: '🆕 New repo…', sublabel: 'Create a folder, git init it, seed README / .gitignore / CLAUDE.md, and make the first commit' },
	];
	if (registered > 0) out.push({ id: 'existing', label: 'Existing repo on the floor…', sublabel: `Pick one of the ${registered} registered target${registered === 1 ? '' : 's'}` });
	out.push(
		{ id: 'browse', label: '📂 Browse to a folder…', sublabel: 'A git repo, a folder of repos, or a plain folder (terminals run in it, no worktree)' },
		{ id: 'none', label: 'No repo for now', sublabel: 'An empty tab — pick targets from the toolbar later' },
	);
	return out;
}

/** The toolbar a freshly linked tab opens on: its repo selected, and the branch the repo was
 *  created on when we know it. Model/effort/layout are left to their defaults. */
export function toolbarForLink(repo: RepoConfig, branch?: string): ToolbarState {
	return { repo: repo.name, ...(branch && !repo.folder ? { branch } : {}) };
}

/** Where the new-repo form proposes to put a repo: wherever the last one went, else beside the
 *  first registered git repo (on most machines, the dev root), else nothing — the form then
 *  requires a Browse rather than guessing a folder to write into. */
export function defaultNewRepoParent(lastParent: unknown, repos: RepoConfig[]): string {
	if (typeof lastParent === 'string' && lastParent.trim()) return lastParent;
	const firstGit = repos.find((r) => !r.folder);
	return firstGit ? path.dirname(firstGit.path) : '';
}

/** Hover text for a tab: where it is linked, or nothing at all for an unlinked tab (unchanged). */
export function tabTitle(ws: Workspace, repos: RepoConfig[]): string | undefined {
	if (!ws.repo) return undefined;
	const r = linkedRepo(repos, ws.repo);
	return r ? `Linked to ${r.name} — ${r.path}` : `Linked to ${ws.repo} (no longer on the floor)`;
}
