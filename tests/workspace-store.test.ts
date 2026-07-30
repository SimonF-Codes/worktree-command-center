import { describe, it, expect } from 'vitest';
import { slugId, uniqueId, addWorkspace, closeWorkspace, renameWorkspace, nextActiveAfter, normalizeWorkspaces } from '../src/terminals/workspace-store';

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
describe('renameWorkspace', () => {
  const list = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];

  it('renames only the target, and only its label', () => {
    const next = renameWorkspace(list, 'b', 'Gamma')!;
    expect(next).toEqual([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Gamma' }]);
  });

  it('NEVER changes the id — it keys the coordination dir and the persisted sessions', () => {
    const next = renameWorkspace([{ id: 'card-tzar', name: 'Card Tzar' }], 'card-tzar', 'Totally Different')!;
    expect(next[0]!.id).toBe('card-tzar');
    expect(next[0]!.name).toBe('Totally Different');
  });

  it('trims, and returns null when nothing would change', () => {
    expect(renameWorkspace(list, 'a', '  Trimmed  ')![0]!.name).toBe('Trimmed');
    expect(renameWorkspace(list, 'a', '   ')).toBeNull();     // blank
    expect(renameWorkspace(list, 'a', 'Alpha')).toBeNull();   // same name
    expect(renameWorkspace(list, 'nope', 'X')).toBeNull();    // unknown id
  });

  it('does not mutate the input list', () => {
    const before = JSON.parse(JSON.stringify(list));
    renameWorkspace(list, 'a', 'Changed');
    expect(list).toEqual(before);
  });

  it('allows two tabs to share a display name (ids still differ)', () => {
    const next = renameWorkspace(list, 'b', 'Alpha')!;
    expect(next.map((w) => w.name)).toEqual(['Alpha', 'Alpha']);
    expect(next.map((w) => w.id)).toEqual(['a', 'b']);
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
