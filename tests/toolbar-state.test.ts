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

describe('layout preference (per workspace, beside repo/branch/model/effort)', () => {
	it('keeps a named layout mode', () => {
		expect(normalizeToolbarState({ repo: 'A', layout: 'columns' })).toEqual({ repo: 'A', layout: 'columns' });
	});
	it("drops 'auto' — it is the default, so it is not a choice worth persisting", () => {
		expect(normalizeToolbarState({ repo: 'A', layout: 'auto' })).toEqual({ repo: 'A' });
		expect(setToolbarState({ a: { layout: 'grid' } }, 'a', { layout: 'auto' })).toEqual({});
	});
	it('drops junk rather than persisting an unknown mode', () => {
		expect(normalizeToolbarState({ layout: 'diagonal' })).toEqual({});
		expect(normalizeToolbarState({ layout: 7 })).toEqual({});
	});
	it('rides the existing per-workspace machinery — set, replace and prune', () => {
		const one = setToolbarState({}, 'ws1', { repo: 'A', layout: 'rows' });
		const two = setToolbarState(one, 'ws2', { layout: 'focus' });
		expect(two).toEqual({ ws1: { repo: 'A', layout: 'rows' }, ws2: { layout: 'focus' } });
		expect(pruneToolbars(two, ['ws2'])).toEqual({ ws2: { layout: 'focus' } });
		expect(normalizeToolbars(two)).toEqual(two);
	});
});
