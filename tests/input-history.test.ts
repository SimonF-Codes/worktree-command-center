import { describe, it, expect } from 'vitest';
import { InputHistory } from '../src/terminals/input-history';

describe('InputHistory', () => {
	it('Up with no history does nothing', () => {
		expect(new InputHistory().up('typing')).toBeNull();
	});

	it('Up walks from newest to oldest, then stops', () => {
		const h = new InputHistory();
		h.record('first'); h.record('second'); h.record('third');
		expect(h.up('')).toBe('third');
		expect(h.up('third')).toBe('second');
		expect(h.up('second')).toBe('first');
		expect(h.up('first')).toBeNull(); // already at the oldest
	});

	it('Down walks back toward newer and then restores the stashed draft', () => {
		const h = new InputHistory();
		h.record('a'); h.record('b');
		expect(h.up('draft')).toBe('b'); // stashes "draft"
		expect(h.up('b')).toBe('a');
		expect(h.down()).toBe('b');
		expect(h.down()).toBe('draft'); // stepped past the newest → the draft comes back
		expect(h.down()).toBeNull();    // not navigating anymore
	});

	it('the stashed draft can be empty', () => {
		const h = new InputHistory();
		h.record('x');
		expect(h.up('')).toBe('x');
		expect(h.down()).toBe(''); // empty draft is a real value, not "no change"
	});

	it('ignores empties and immediate duplicates when recording', () => {
		const h = new InputHistory();
		h.record(''); h.record('same'); h.record('same'); h.record('other');
		expect(h.up('')).toBe('other');
		expect(h.up('other')).toBe('same');
		expect(h.up('same')).toBeNull(); // only one "same" was kept, and no empty
	});

	it('recording after navigating resets position to the newest', () => {
		const h = new InputHistory();
		h.record('one'); h.record('two');
		h.up(''); // now navigating at "two"
		h.record('three');
		expect(h.down()).toBeNull(); // navigation was reset by record()
		expect(h.up('')).toBe('three');
	});

	it('Down while not navigating is a no-op', () => {
		const h = new InputHistory();
		h.record('one');
		expect(h.down()).toBeNull();
	});
});
