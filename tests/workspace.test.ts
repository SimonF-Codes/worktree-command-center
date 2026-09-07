import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { pickRepos, mergeRepos, repoOptionLabel, reposForWorkspace, discoverRepos, type DirEntry } from '../src/workspace';
import type { RepoConfig } from '../src/terminals/terminals-grid';

describe('pickRepos', () => {
  it('returns a single entry named after the basename when the folder is itself a repo', () => {
    const folder = path.join('C:', 'Dev', 'my-project');
    const result = pickRepos(folder, true, []);
    expect(result).toEqual([{ name: 'my-project', path: folder }]);
  });

  it('ignores subdirs when the folder is a repo (folderHasGit=true)', () => {
    const folder = path.join('C:', 'Dev', 'my-project');
    const subdirs: DirEntry[] = [
      { name: 'sub-a', hasGit: true },
      { name: 'sub-b', hasGit: false },
    ];
    const result = pickRepos(folder, true, subdirs);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('my-project');
  });

  it('returns only git subdirs when the folder is not a repo', () => {
    const folder = path.join('C:', 'Dev');
    const subdirs: DirEntry[] = [
      { name: 'repo-a', hasGit: true },
      { name: 'not-a-repo', hasGit: false },
      { name: 'repo-b', hasGit: true },
    ];
    const result = pickRepos(folder, false, subdirs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'repo-a', path: path.join(folder, 'repo-a') });
    expect(result[1]).toEqual({ name: 'repo-b', path: path.join(folder, 'repo-b') });
  });

  it('returns the folder itself as a folder target when neither it nor any subdir has .git', () => {
    const folder = path.join('C:', 'Notes', 'inbox');
    const subdirs: DirEntry[] = [
      { name: 'folder-1', hasGit: false },
      { name: 'folder-2', hasGit: false },
    ];
    const result = pickRepos(folder, false, subdirs);
    expect(result).toEqual([{ name: 'inbox', path: folder, folder: true }]);
  });

  it('returns the folder itself as a folder target when it has no subdirs at all', () => {
    const folder = path.join('C:', 'Notes', 'inbox');
    const result = pickRepos(folder, false, []);
    expect(result).toEqual([{ name: 'inbox', path: folder, folder: true }]);
  });

  it('prefers git subdirs over adding the parent as a folder target', () => {
    const folder = path.join('C:', 'Dev');
    const subdirs: DirEntry[] = [
      { name: 'repo-a', hasGit: true },
      { name: 'plain', hasGit: false },
    ];
    const result = pickRepos(folder, false, subdirs);
    expect(result).toEqual([{ name: 'repo-a', path: path.join(folder, 'repo-a') }]);
  });

  it('does not mark a git repo as a folder target', () => {
    const folder = path.join('C:', 'Dev', 'my-project');
    expect(pickRepos(folder, true, [])[0]!.folder).toBeUndefined();
  });
});

describe('mergeRepos', () => {
  it('deduplicates by resolved path, keeping the existing entry', () => {
    const existing = [{ name: 'existing-name', path: path.join('C:', 'Dev', 'repo-a') }];
    const add = [{ name: 'new-name', path: path.join('C:', 'Dev', 'repo-a') }];
    const result = mergeRepos(existing, add);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('existing-name');
  });

  it('adds new repos that are not already in existing', () => {
    const existing = [{ name: 'repo-a', path: path.join('C:', 'Dev', 'repo-a') }];
    const add = [
      { name: 'repo-b', path: path.join('C:', 'Dev', 'repo-b') },
      { name: 'repo-c', path: path.join('C:', 'Dev', 'repo-c') },
    ];
    const result = mergeRepos(existing, add);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(['repo-a', 'repo-b', 'repo-c']);
  });

  it('handles empty existing array', () => {
    const add = [
      { name: 'repo-a', path: path.join('C:', 'Dev', 'repo-a') },
      { name: 'repo-b', path: path.join('C:', 'Dev', 'repo-b') },
    ];
    const result = mergeRepos([], add);
    expect(result).toHaveLength(2);
    expect(result).toEqual(add);
  });

  it('handles empty add array', () => {
    const existing = [{ name: 'repo-a', path: path.join('C:', 'Dev', 'repo-a') }];
    const result = mergeRepos(existing, []);
    expect(result).toEqual(existing);
  });

  it('deduplicates using path.resolve so trailing slash differences are handled', () => {
    const base = path.join('C:', 'Dev', 'repo-a');
    const existing = [{ name: 'repo-a', path: base }];
    // path.resolve normalizes, so same path = duplicate
    const add = [{ name: 'repo-a-dup', path: path.resolve(base) }];
    const result = mergeRepos(existing, add);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('repo-a');
  });
});

describe('repoOptionLabel', () => {
  it('marks folder targets so the empty branch picker is expected, not confusing', () => {
    expect(repoOptionLabel({ name: 'notes', path: 'C:/notes', folder: true })).toBe('📁 notes');
  });

  it('leaves git repos unmarked', () => {
    expect(repoOptionLabel({ name: 'my-app', path: 'C:/dev/my-app' })).toBe('my-app');
  });
});

describe('reposForWorkspace', () => {
  const repos: RepoConfig[] = [
    { name: 'Shared', path: '/s' },
    { name: 'OnlyA', path: '/a', group: 'a' },
    { name: 'OnlyB', path: '/b', group: 'b' },
  ];

  it('shows ungrouped repos in every workspace', () => {
    expect(reposForWorkspace(repos, 'a').map((r) => r.name)).toContain('Shared');
    expect(reposForWorkspace(repos, 'b').map((r) => r.name)).toContain('Shared');
  });

  it('shows a grouped repo only in its own workspace', () => {
    expect(reposForWorkspace(repos, 'a').map((r) => r.name)).toEqual(['Shared', 'OnlyA']);
    expect(reposForWorkspace(repos, 'b').map((r) => r.name)).toEqual(['Shared', 'OnlyB']);
  });

  it('is a no-op for configs where nothing is grouped (every existing config)', () => {
    const plain: RepoConfig[] = [{ name: 'X', path: '/x' }, { name: 'Y', path: '/y' }];
    expect(reposForWorkspace(plain, 'anything')).toEqual(plain);
  });
});

describe('discoverRepos (IO wrapper)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-discover-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns just the folder when it is itself a git repo', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    expect(discoverRepos(tmp)).toEqual([{ name: path.basename(tmp), path: tmp }]);
  });

  it('returns the git subdirs when the folder holds repos', () => {
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(tmp, name, '.git'), { recursive: true });
    }
    fs.mkdirSync(path.join(tmp, 'plain-dir')); // no .git → excluded
    const got = discoverRepos(tmp).sort((a, b) => a.name.localeCompare(b.name));
    expect(got).toEqual([
      { name: 'alpha', path: path.join(tmp, 'alpha') },
      { name: 'beta', path: path.join(tmp, 'beta') },
    ]);
  });

  it('returns the folder itself as a plain FOLDER target when neither it nor its subdirs are repos', () => {
    fs.mkdirSync(path.join(tmp, 'notes'));
    expect(discoverRepos(tmp)).toEqual([{ name: path.basename(tmp), path: tmp, folder: true }]);
  });

  it('never throws on an unreadable path — falls back to a folder target', () => {
    const missing = path.join(tmp, 'does-not-exist');
    expect(discoverRepos(missing)).toEqual([{ name: 'does-not-exist', path: missing, folder: true }]);
  });
});
