import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { tabLinkOptions, toolbarForLink, defaultNewRepoParent, tabTitle } from '../src/tab-repo';
import type { RepoConfig } from '../src/terminals/terminals-grid';

describe('tabLinkOptions', () => {
	it('leads with a new repo and keeps "no repo" as a real, last choice', () => {
		expect(tabLinkOptions(3).map((o) => o.id)).toEqual(['new', 'existing', 'browse', 'none']);
	});
	it('does not offer an empty "existing" list on a fresh install', () => {
		expect(tabLinkOptions(0).map((o) => o.id)).toEqual(['new', 'browse', 'none']);
		expect(tabLinkOptions(1).find((o) => o.id === 'existing')!.sublabel).toMatch(/1 registered target$/);
	});
});

describe('toolbarForLink', () => {
	it('selects the linked repo, and the branch it was created on', () => {
		expect(toolbarForLink({ name: 'app', path: '/d/app' }, 'trunk')).toEqual({ repo: 'app', branch: 'trunk' });
		expect(toolbarForLink({ name: 'app', path: '/d/app' })).toEqual({ repo: 'app' });
	});
	it('never gives a folder target a branch', () => {
		expect(toolbarForLink({ name: 'notes', path: '/d/notes', folder: true }, 'main')).toEqual({ repo: 'notes' });
	});
});

describe('defaultNewRepoParent', () => {
	const repos: RepoConfig[] = [{ name: 'notes', path: path.resolve('/vault/notes'), folder: true }, { name: 'app', path: path.resolve('/dev/app') }];
	it('prefers where the last new repo went', () => {
		expect(defaultNewRepoParent('D:/projects', repos)).toBe('D:/projects');
	});
	it('else sits beside the first git repo (a folder target is not a dev root)', () => {
		expect(defaultNewRepoParent(undefined, repos)).toBe(path.resolve('/dev'));
	});
	it('else proposes nothing, so the form makes you choose instead of guessing where to write', () => {
		expect(defaultNewRepoParent('  ', [])).toBe('');
		expect(defaultNewRepoParent(42, [])).toBe('');
	});
});

describe('tabTitle', () => {
	const repos: RepoConfig[] = [{ name: 'app', path: path.resolve('/dev/app') }];
	it('is undefined for an unlinked tab — an existing tab looks exactly as it did', () => {
		expect(tabTitle({ id: 'default', name: 'default' }, repos)).toBeUndefined();
	});
	it('names the linked repo, or says plainly that it has left the floor', () => {
		expect(tabTitle({ id: 'a', name: 'A', repo: path.resolve('/dev/app') }, repos)).toBe(`Linked to app — ${path.resolve('/dev/app')}`);
		expect(tabTitle({ id: 'a', name: 'A', repo: '/gone' }, repos)).toMatch(/no longer on the floor/);
	});
});
