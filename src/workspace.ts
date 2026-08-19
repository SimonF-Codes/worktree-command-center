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
