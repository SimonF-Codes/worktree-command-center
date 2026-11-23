import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JournalStore, slugify } from '../src/terminals/journal-store';
import { makeTempDir } from './temp-dir';

describe('slugify', () => {
  it('makes a filesystem-safe slug', () => {
    expect(slugify('Standup Notes 6/26')).toBe('standup-notes-6-26');
    expect(slugify('  Hello!!  ')).toBe('hello');
  });
  it('falls back to "journal" when empty', () => {
    expect(slugify('   ')).toBe('journal');
    expect(slugify('!!!')).toBe('journal');
  });
});

describe('JournalStore', () => {
  let dir: string; let store: JournalStore;
  beforeEach(() => { dir = makeTempDir('jrnl-'); store = new JournalStore(dir); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('save → load round-trips name + text', () => {
    store.save('a', 'A note', 'line 1\nline 2', 1000);
    expect(store.load('a')).toEqual({ name: 'A note', text: 'line 1\nline 2' });
  });
  it('list returns newest-updated first', () => {
    store.save('a', 'A', 'x', 1000);
    store.save('b', 'B', 'y', 2000);
    expect(store.list().map((m) => m.slug)).toEqual(['b', 'a']);
  });
  it('save overwrites the same slug (no dup)', () => {
    store.save('a', 'A', 'x', 1000);
    store.save('a', 'A2', 'z', 3000);
    expect(store.list()).toEqual([{ slug: 'a', name: 'A2', created: 1000, updated: 3000 }]);
    expect(store.load('a')!.text).toBe('z');
  });
  it('created is the FIRST save time and never moves on later saves', () => {
    store.save('a', 'A', 'x', 1000);
    store.save('a', 'A', 'xx', 2000);
    store.save('a', 'A', 'xxx', 3000);
    expect(store.list()[0]).toMatchObject({ created: 1000, updated: 3000 });
  });
  it('backfills created from updated for legacy index entries', () => {
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([{ slug: 'old', name: 'Old', updated: 500 }]), 'utf8');
    store.save('old', 'Old', 'text', 4000);
    expect(store.list()[0]).toMatchObject({ slug: 'old', created: 500, updated: 4000 });
  });
  it('remove deletes the doc + index entry', () => {
    store.save('a', 'A', 'x', 1000);
    store.remove('a');
    expect(store.load('a')).toBeNull();
    expect(store.list()).toEqual([]);
  });
  it('uniqueSlug de-dups against other journals', () => {
    store.save('standup', 'Standup', 'x', 1000);
    expect(store.uniqueSlug('Standup')).toBe('standup-2');
    expect(store.uniqueSlug('Standup', 'standup')).toBe('standup');
  });
  it('load returns null for unknown slug', () => {
    expect(store.load('nope')).toBeNull();
  });
});
