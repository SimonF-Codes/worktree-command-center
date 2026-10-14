import * as fs from 'fs';
import * as path from 'path';
import type { RepoConfig } from './terminals/terminals-grid';

export interface DirEntry { name: string; hasGit: boolean; }

/** Pure: given a folder, whether it is itself a repo, and its immediate subdirs' git
 *  status, produce the RepoConfig list.
 *  - folder is a repo            → just it
 *  - folder holds git subdirs    → those subdirs (the "pick my dev root" case)
 *  - neither                     → the folder itself as a plain FOLDER target
 *
 *  That last case used to return nothing, so picking a non-git folder silently added
 *  zero targets. A folder target runs terminals directly in the folder (no worktree,
 *  no branch), which is what you want for notes/config/asset dirs that still need work
 *  done in them alongside the git repos. */
export function pickRepos(folder: string, folderHasGit: boolean, subdirs: DirEntry[]): RepoConfig[] {
  if (folderHasGit) return [{ name: path.basename(folder), path: folder }];
  const gitSubdirs = subdirs.filter((d) => d.hasGit);
  if (gitSubdirs.length > 0) return gitSubdirs.map((d) => ({ name: d.name, path: path.join(folder, d.name) }));
  return [{ name: path.basename(folder), path: folder, folder: true }];
}

/** IO wrapper: scan the filesystem and delegate to pickRepos. Never throws. */
export function discoverRepos(folder: string): RepoConfig[] {
  const folderHasGit = fs.existsSync(path.join(folder, '.git'));
  let subdirs: DirEntry[] = [];
  if (!folderHasGit) {
    try {
      subdirs = fs.readdirSync(folder, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, hasGit: fs.existsSync(path.join(folder, d.name, '.git')) }));
    } catch { subdirs = []; }
  }
  return pickRepos(folder, folderHasGit, subdirs);
}

/** Dropdown label: folder targets get a 📁 so it's obvious the branch picker will be empty and
 *  Play won't cut a worktree. The option's VALUE stays the bare name — everything else in the
 *  app (Kane's spawn, persistence) looks targets up by name. */
export function repoOptionLabel(r: RepoConfig): string { return r.folder ? `📁 ${r.name}` : r.name; }

/** Merge new repos into existing, de-duplicated by absolute path (existing kept). */
export function mergeRepos(existing: RepoConfig[], add: RepoConfig[]): RepoConfig[] {
  const seen = new Set(existing.map((r) => path.resolve(r.path)));
  return [...existing, ...add.filter((r) => !seen.has(path.resolve(r.path)))];
}

/** The targets a given workspace tab should offer.
 *
 *  `RepoConfig.group` has been in the type since the beginning but nothing ever read it, so
 *  every tab showed every repo and a workspace scoped only its terminals. Honouring it here
 *  makes a tab able to narrow to its own targets. An ungrouped repo (no `group`) stays visible
 *  everywhere, which is what every existing config has — so this changes nothing until a repo
 *  is deliberately assigned to a workspace. */
export function reposForWorkspace(repos: RepoConfig[], workspaceId: string): RepoConfig[] {
  return repos.filter((r) => !r.group || r.group === workspaceId);
}

/** The registered target a tab is linked to (Workspace.repo is a path), or undefined when the tab
 *  has no link or that repo has since left the floor. Matched by resolved path — the identity
 *  mergeRepos de-duplicates on — never by name, which two repos can share. */
export function linkedRepo(repos: RepoConfig[], repoPath: string | undefined): RepoConfig | undefined {
  if (!repoPath) return undefined;
  const want = path.resolve(repoPath);
  return repos.find((r) => path.resolve(r.path) === want);
}

/** Drop a target, matched by resolved path. The other half of mergeRepos, which only ever
 *  appends: without this a target whose folder moved or died stayed in config.json forever,
 *  and the only fix was a hand-edit with the app closed (persist() rewrites the whole `repos`
 *  key from memory, so an edit made while it runs is overwritten). Unknown path → unchanged. */
export function forgetRepo(repos: RepoConfig[], repoPath: string): RepoConfig[] {
  const gone = path.resolve(repoPath);
  return repos.filter((r) => path.resolve(r.path) !== gone);
}

/** Point an existing target at a new path, keeping its name, group and every other field — the
 *  name is what toolbars and spawns look a target up by, so a repoint must not change it.
 *
 *  If the new path is ALREADY a registered target (someone added the moved folder through Add
 *  folder before repointing), the stale entry is dropped and the existing one kept, rather than
 *  leaving two targets on one folder. Unknown `from` → unchanged. */
export function retargetRepo(repos: RepoConfig[], from: string, to: string): RepoConfig[] {
  const src = path.resolve(from), dst = path.resolve(to);
  if (src === dst || !repos.some((r) => path.resolve(r.path) === src)) return repos;
  if (repos.some((r) => path.resolve(r.path) === dst)) return forgetRepo(repos, from);
  return repos.map((r) => (path.resolve(r.path) === src ? { ...r, path: to } : r));
}
