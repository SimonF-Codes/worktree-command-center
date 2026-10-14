import { describe, it, expect } from 'vitest';
import { slugId, uniqueId, addWorkspace, closeWorkspace, nextActiveAfter, normalizeWorkspaces, linkWorkspaceRepo } from '../src/terminals/workspace-store';

describe('slugId', () => {
  it('makes a filesystem-safe id', () => {
    expect(slugId('Card Tzar!')).toBe('card-tzar');
    expect(slugId('   ')).toBe('workspace');
  });
});
describe('uniqueId', () => {
  it('suffixes on collision', () => {
    expect(uniqueId('a', [])).toBe('a');
    expect(uniqueId('a', ['a'])).toBe('a-2');
    expect(uniqueId('a', ['a', 'a-2'])).toBe('a-3');
  });
});
describe('addWorkspace', () => {
  it('appends with a unique id; rejects blank', () => {
    const r = addWorkspace([{ id: 'default', name: 'default' }], 'cardtzar');
    expect(r).not.toBeNull();
    expect(r!.id).toBe('cardtzar');
    expect(r!.list.map((w) => w.id)).toEqual(['default', 'cardtzar']);
    expect(addWorkspace([], '   ')).toBeNull();
    const dup = addWorkspace([{ id: 'cardtzar', name: 'cardtzar' }], 'cardtzar');
    expect(dup!.id).toBe('cardtzar-2');
  });
});
describe('closeWorkspace', () => {
  it('removes a workspace but never the last', () => {
    expect(closeWorkspace([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], 'a').map((w) => w.id)).toEqual(['b']);
    expect(closeWorkspace([{ id: 'a', name: 'a' }], 'a').map((w) => w.id)).toEqual(['a']);
  });
});
describe('nextActiveAfter', () => {
  it('picks a surviving neighbor', () => {
    const list = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }];
    expect(nextActiveAfter(list, 'b', 'b')).toBe('a'); // previous if it exists
    expect(nextActiveAfter(list, 'a', 'a')).toBe('b'); // else next
    expect(nextActiveAfter(list, 'b', 'a')).toBe('a'); // closing a non-active leaves active as-is
  });
});
describe('normalizeWorkspaces', () => {
  it('defaults junk to a single default workspace and dedupes', () => {
    expect(normalizeWorkspaces(undefined)).toEqual([{ id: 'default', name: 'default' }]);
    expect(normalizeWorkspaces('nope')).toEqual([{ id: 'default', name: 'default' }]);
    expect(normalizeWorkspaces([{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }])).toEqual([{ id: 'a', name: 'A' }]);
  });
});
describe('workspace repo link', () => {
  it('normalizeWorkspaces keeps a linked repo path and leaves unlinked tabs exactly as they were', () => {
    expect(normalizeWorkspaces([{ id: 'a', name: 'A', repo: 'C:/dev/a' }, { id: 'b', name: 'B' }]))
      .toEqual([{ id: 'a', name: 'A', repo: 'C:/dev/a' }, { id: 'b', name: 'B' }]);
    // A junk or empty link is dropped, never kept as a link to nowhere.
    expect(normalizeWorkspaces([{ id: 'a', name: 'A', repo: '' }, { id: 'b', name: 'B', repo: 42 }]))
      .toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  });
  it('linkWorkspaceRepo links, relinks and unlinks one tab without touching the others', () => {
    const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', repo: '/old' }];
    expect(linkWorkspaceRepo(list, 'a', '/x')).toEqual([{ id: 'a', name: 'A', repo: '/x' }, list[1]]);
    expect(linkWorkspaceRepo(list, 'b', '/new')[1]).toEqual({ id: 'b', name: 'B', repo: '/new' });
    expect(linkWorkspaceRepo(list, 'b', undefined)[1]).toEqual({ id: 'b', name: 'B' });
    expect(linkWorkspaceRepo(list, 'zz', '/x')).toEqual(list);
    expect(list[0]).toEqual({ id: 'a', name: 'A' }); // immutable
  });
});
