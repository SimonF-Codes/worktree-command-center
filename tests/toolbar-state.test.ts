import { describe, it, expect } from 'vitest';
import { normalizeToolbarState, normalizeToolbars, setToolbarState, pruneToolbars } from '../src/terminals/toolbar-state';

describe('normalizeToolbarState', () => {
	it('keeps known string keys', () => {
		expect(normalizeToolbarState({ repo: 'ChessEdu', branch: 'main', model: 'opus', effort: 'high' }))
			.toEqual({ repo: 'ChessEdu', branch: 'main', model: 'opus', effort: 'high' });
	});
	it('drops empty strings — an unset dropdown is not a choice', () => {
		expect(normalizeToolbarState({ repo: 'ChessEdu', model: '', effort: '' })).toEqual({ repo: 'ChessEdu' });
	});
	it('drops unknown keys and non-strings', () => {
		expect(normalizeToolbarState({ repo: 'A', bogus: 'x', branch: 7 })).toEqual({ repo: 'A' });
	});
	it('survives junk', () => {
		expect(normalizeToolbarState(null)).toEqual({});
		expect(normalizeToolbarState('nope')).toEqual({});
		expect(normalizeToolbarState(undefined)).toEqual({});
	});
});

describe('normalizeToolbars', () => {
	it('normalizes each workspace and drops ones left empty', () => {
		expect(normalizeToolbars({ a: { repo: 'A' }, b: { model: '' }, c: 'junk' })).toEqual({ a: { repo: 'A' } });
	});
	it('survives junk', () => {
		expect(normalizeToolbars(null)).toEqual({});
		expect(normalizeToolbars([])).toEqual({});
	});
});

describe('setToolbarState', () => {
	it('sets without mutating the input', () => {
		const before = { a: { repo: 'A' } };
		const after = setToolbarState(before, 'b', { repo: 'B' });
		expect(after).toEqual({ a: { repo: 'A' }, b: { repo: 'B' } });
		expect(before).toEqual({ a: { repo: 'A' } });
	});
	it('replaces an existing workspace entry', () => {
		expect(setToolbarState({ a: { repo: 'A', branch: 'main' } }, 'a', { repo: 'Z' })).toEqual({ a: { repo: 'Z' } });
	});
	it('removes the entry when the selection is empty', () => {
		expect(setToolbarState({ a: { repo: 'A' } }, 'a', {})).toEqual({});
	});
});

describe('pruneToolbars', () => {
	it('drops state for workspaces that no longer exist', () => {
		expect(pruneToolbars({ a: { repo: 'A' }, gone: { repo: 'G' } }, ['a'])).toEqual({ a: { repo: 'A' } });
	});
	it('keeps everything when all ids are live', () => {
		const all = { a: { repo: 'A' }, b: { repo: 'B' } };
		expect(pruneToolbars(all, ['a', 'b'])).toEqual(all);
	});
});
