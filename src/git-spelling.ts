import * as fs from 'fs';
import * as path from 'path';
import { isInside, samePath } from './move-repo';
import { parseWorktreeList } from './terminals/worktree-registry';

// One repository, two spellings. git canonicalises every path it records or reports: on Windows
// it expands 8.3 short names (`RUNNER~1` → `runneradmin`), and everywhere it resolves junctions
// and symlinks. A target is registered the way the user reached it, and everything the app
// derives from that path is spelled the same way: the worktree directories it creates, the cwd of
// every terminal, the sessions file, config.json, and the ~/.claude/projects folder each
// conversation is filed under. `path.resolve` does not bridge the two (it neither expands 8.3
// names nor follows links), so a string comparison between git's list and the registered path
// finds nothing where something is.
//
// The fix is at GATHER, where git's answer is read: every path git reports is rewritten into the
// registered spelling before anything compares it. Not the other way round (canonicalising the
// registered side) because the app's stored paths and transcript folder names would then be the
// odd ones out, and a move would silently skip re-pointing them.

/** `p` as the OS, and so git, spells it: `fs.realpathSync.native`, the only resolver that both
 *  expands 8.3 names and follows links (`fs.realpathSync` keeps an 8.3 name as given). A path
 *  that does not exist, which is prune's and move's daily business, is resolved through its
 *  longest existing ancestor and the rest appended as given, rather than thrown on or left
 *  unresolved: a gone worktree under a junctioned folder still gets the folder's real spelling. */
export function canonicalPath(p: string): string {
	const abs = path.resolve(p);
	const rest: string[] = [];
	for (let cur = abs; ;) {
		try {
			const real = fs.realpathSync.native(cur);
			return rest.length ? path.join(real, ...rest.reverse()) : real;
		} catch {
			const up = path.dirname(cur);
			if (up === cur) return abs;
			rest.push(path.basename(cur));
			cur = up;
		}
	}
}

/** A rewriter for paths git reported, into the spelling of the `registered` paths (a target's
 *  path, a move's destination). Each registered path and its parent (the old shared worktree
 *  root, and loose worktrees, sit beside the repo) is an anchor; a git path inside an anchor's
 *  canonical form is re-rooted under the anchor as registered, the deepest anchor winning. A path
 *  under no anchor, or anchors already spelled as git spells them, come back unchanged. */
export function inRegisteredSpelling(registered: readonly string[], ci = process.platform === 'win32'): (gitPath: string) => string {
	const anchors = [...new Set(registered.flatMap((r) => [path.resolve(r), path.dirname(path.resolve(r))]))]
		.map((as) => ({ as, canon: canonicalPath(as) }))
		.filter((a) => !samePath(a.as, a.canon, ci))
		.sort((a, b) => b.canon.length - a.canon.length);
	return (p) => {
		for (const a of anchors) {
			if (!isInside(p, a.canon, ci)) continue;
			const rel = path.relative(a.canon, path.resolve(p));
			return rel ? path.join(a.as, rel) : a.as;
		}
		return p;
	};
}

/** The worktree scan's view of one target: what `git worktree list --porcelain` names, the
 *  primary checkout left out, each path in the spelling `repoPath` was registered under, so it
 *  matches the tiles' cwds (and so Reopen opens a worktree where its conversation is filed). A path
 *  that needs no respelling is returned exactly as git printed it. */
export function scannedWorktrees(porcelain: string, repoPath: string, ci = process.platform === 'win32'): { path: string; branch: string }[] {
	const respell = inRegisteredSpelling([repoPath], ci);
	return parseWorktreeList(porcelain)
		.map((w) => ({ ...w, path: respell(w.path) }))
		.filter((w) => !samePath(w.path, repoPath, ci));
}
