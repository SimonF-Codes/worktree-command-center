import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pickRepos, mergeRepos, repoOptionLabel, type DirEntry } from '../src/workspace';

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
