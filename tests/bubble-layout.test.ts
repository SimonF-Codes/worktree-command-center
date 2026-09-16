import { describe, it, expect } from 'vitest';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, physicalKeyLabel, nextSpotlight, bestFitShape, cellsInTile, minTileSize, DEFAULT_CELL_METRICS, type CellMetrics } from '../src/terminals/bubble-layout';

/** A deliberately round cell so the arithmetic in these tests is checkable by hand:
 *  10px per column, 20px per row, 80x20 minimum ⇒ a usable tile is 800x400 + chrome. */
const M: CellMetrics = { cw: 10, ch: 20, chromeW: 0, chromeH: 0, minCols: 80, minRows: 20 };

describe('cellsInTile / minTileSize', () => {
	it('converts a pixel box into character cells, chrome first', () => {
		expect(cellsInTile(800, 400, M)).toEqual({ cols: 80, rows: 20 });
		expect(cellsInTile(800, 400, { ...M, chromeW: 10, chromeH: 40 })).toEqual({ cols: 79, rows: 18 });
	});
	it('never reports negative cells for a tile smaller than its own chrome', () => {
		expect(cellsInTile(4, 4, { ...M, chromeW: 10, chromeH: 40 })).toEqual({ cols: 0, rows: 0 });
	});
	it('minTileSize is the minimum in cells, priced at the CURRENT font', () => {
		expect(minTileSize(M)).toEqual({ w: 800, h: 400 });
		expect(minTileSize({ ...M, cw: 20, ch: 40 })).toEqual({ w: 1600, h: 800 }); // bigger font ⇒ bigger floor
	});
});

describe('bestFitShape — the shape comes from the BOX, not from sqrt(n)', () => {
	it('n=4 on a PORTRAIT stage is one column, not 2x2', () => {
		expect(bestFitShape(4, 900, 2400, 8, M)).toEqual({ cols: 1, rows: 4 });
	});
	it('n=4 on an ULTRAWIDE stage is one row, not 2x2', () => {
		expect(bestFitShape(4, 5120, 900, 8, M)).toEqual({ cols: 4, rows: 1 });
	});
	it('n=4 on a SQUARE stage stays 2x2', () => {
		expect(bestFitShape(4, 2000, 2000, 8, M)).toEqual({ cols: 2, rows: 2 });
	});
	it('a single tile is always 1x1', () => {
		expect(bestFitShape(1, 400, 4000, 8, M)).toEqual({ cols: 1, rows: 1 });
	});
	it('the same n on the same aspect but a different FONT can want a different shape', () => {
		const box = { W: 1800, H: 1000 };
		// Small cells: two columns each clear 80 cols, so the wide box splits sideways.
		expect(bestFitShape(2, box.W, box.H, 8, { ...M, cw: 5, ch: 10 })).toEqual({ cols: 2, rows: 1 });
		// Double the font and a half-width tile no longer clears 80 columns — stack instead.
		expect(bestFitShape(2, box.W, box.H, 8, { ...M, cw: 20, ch: 20 })).toEqual({ cols: 1, rows: 2 });
	});
	it('once both axes are comfortable, the abundant dimension is spent (16:9, two tiles)', () => {
		// Both shapes clear 80x20 easily here; the headroom cap stops the score from preferring
		// a 267x26 letterbox strip over a 132x56 tile just because it maximises columns.
		expect(bestFitShape(2, 1900, 950, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 2, rows: 1 });
	});
	it('six tiles on a big 16:9 screen come out 3x2, not six slivers or six strips', () => {
		expect(bestFitShape(6, 3840, 2000, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 3, rows: 2 });
	});
	it('chooses cols*rows >= n, never fewer slots than tiles', () => {
		for (let n = 1; n <= 12; n++) {
			const s = bestFitShape(n, 1600, 1000, 8, M);
			expect(s.cols * s.rows).toBeGreaterThanOrEqual(n);
			expect(s.cols).toBeGreaterThanOrEqual(1);
			expect(s.rows).toBeGreaterThanOrEqual(1);
		}
	});
});

describe('settledLayout', () => {
	it('lays N tiles in an adaptive grid, all within bounds when they fit', () => {
		const r = settledLayout([1, 2, 3, 4], 2000, 1400, 8, { metrics: M });
		expect(r).toHaveLength(4);
		for (const t of r) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.x + t.w).toBeLessThanOrEqual(2000);
			expect(t.y + t.h).toBeLessThanOrEqual(1400);
			expect(t.w).toBeGreaterThan(0);
			expect(t.h).toBeGreaterThan(0);
		}
	});
	it('returns [] for no tiles', () => {
		expect(settledLayout([], 800, 600, 8)).toEqual([]);
	});
	it('stacks full-width tiles on a portrait stage (the 2x2-on-a-vertical-monitor bug)', () => {
		const r = settledLayout([1, 2, 3, 4], 900, 2400, 8, { metrics: M });
		expect(new Set(r.map((t) => t.x)).size).toBe(1);       // one column
		expect(new Set(r.map((t) => t.y)).size).toBe(4);       // four rows
		expect(r[0]!.w).toBe(900 - 16);                        // full width, not half of it
	});
	it('spreads full-height columns on an ultrawide stage', () => {
		const r = settledLayout([1, 2, 3, 4], 5120, 900, 8, { metrics: M });
		expect(new Set(r.map((t) => t.y)).size).toBe(1);
		expect(new Set(r.map((t) => t.x)).size).toBe(4);
		expect(r[0]!.h).toBe(900 - 16);
	});
	it('honours the minimum and overflows the stage rather than shrinking below it', () => {
		// Four tiles on a box that cannot give any of them 80x20: tiles stay at the minimum and
		// the layout runs off the stage, which then scrolls.
		const r = settledLayout([1, 2, 3, 4], 900, 500, 8, { metrics: M });
		const min = minTileSize(M);
		for (const t of r) { expect(t.w).toBe(min.w); expect(t.h).toBe(min.h); }
		expect(Math.max(...r.map((t) => t.x + t.w))).toBeGreaterThan(900); // scrolls, by design
	});
	it('an explicit shape overrides the search (Columns / Rows modes)', () => {
		const r = settledLayout([1, 2, 3], 2400, 1400, 8, { metrics: M, shape: { cols: 3, rows: 1 } });
		expect(new Set(r.map((t) => t.y)).size).toBe(1);
	});
	it('defaults to the built-in metrics when none are injected', () => {
		expect(settledLayout([1], 1000, 600, 8)).toEqual(settledLayout([1], 1000, 600, 8, { metrics: DEFAULT_CELL_METRICS }));
	});
});

describe('centeredLayout', () => {
	it('centers the chosen tile and includes every id', () => {
		const r = centeredLayout([1, 2, 3, 4, 5], 1000, 600, 8, 3);
		expect(r).toHaveLength(5);
		expect(r.map((x) => x.id).sort()).toEqual([1, 2, 3, 4, 5]);
		const c = r.find((x) => x.id === 3)!;
		expect(c.x).toBeGreaterThan(150);
		expect(c.x + c.w).toBeLessThan(850);
		const maxW = Math.max(...r.map((x) => x.w));
		expect(c.w).toBe(maxW);
	});
	it('falls back to settled when centeredId is absent', () => {
		const r = centeredLayout([1, 2], 800, 600, 8, 99);
		expect(r).toHaveLength(2);
	});
	it('fills full height (no blank bands) when only left/right satellites exist', () => {
		const r = centeredLayout([1, 2, 3], 1000, 600, 8, 1);
		expect(r).toHaveLength(3);
		const c = r.find((x) => x.id === 1)!;
		expect(c.h).toBeGreaterThan(600 * 0.9); // center spans almost the whole height
		expect(c.w).toBe(Math.max(...r.map((x) => x.w)));
		for (const t of r) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.x + t.w).toBeLessThanOrEqual(1000);
			expect(t.y + t.h).toBeLessThanOrEqual(600);
		}
	});
	it('a lone centered tile fills the whole stage', () => {
		const r = centeredLayout([7], 1000, 600, 8, 7);
		expect(r).toHaveLength(1);
		expect(r[0]!.w).toBe(1000 - 16);
		expect(r[0]!.h).toBe(600 - 16);
	});
});

describe('keyForIndex / keyToIndex', () => {
	it('maps F1..F12 then A,B,…', () => {
		expect(keyForIndex(0)).toBe('F1');
		expect(keyForIndex(11)).toBe('F12');
		expect(keyForIndex(12)).toBe('A');
		expect(keyForIndex(13)).toBe('B');
	});
	it('round-trips', () => {
		for (let i = 0; i < 16; i++) expect(keyToIndex(keyForIndex(i))).toBe(i);
		expect(keyToIndex('F13')).toBeNull();
		expect(keyToIndex('1')).toBeNull();
	});
});

describe('physicalKeyLabel', () => {
	it('prefers .code for plain letters, unaffected by what .key composed', () => {
		expect(physicalKeyLabel({ key: 'a', code: 'KeyA' })).toBe('A');
		expect(physicalKeyLabel({ key: 'l', code: 'KeyL' })).toBe('L');
	});
	it('uses .code even when macOS Option composed .key into an accented/special character', () => {
		// Real Chromium/macOS behavior: Option+L reports key="¬", Option+C reports key="ç" — the
		// bug this function exists to route around (Option+<letter> shortcuts were unusable).
		expect(physicalKeyLabel({ key: '¬', code: 'KeyL' })).toBe('L');
		expect(physicalKeyLabel({ key: 'ç', code: 'KeyC' })).toBe('C');
		expect(physicalKeyLabel({ key: 'å', code: 'KeyA' })).toBe('A');
	});
	it('leaves function keys as-is (.key, not subject to Option composition)', () => {
		expect(physicalKeyLabel({ key: 'F1', code: 'F1' })).toBe('F1');
		expect(physicalKeyLabel({ key: 'F12', code: 'F12' })).toBe('F12');
	});
	it('falls back to .key for anything without a KeyX code (e.g. digits, punctuation)', () => {
		expect(physicalKeyLabel({ key: '1', code: 'Digit1' })).toBe('1');
		});
	});

describe('nextSpotlight (Alt+←/→ cycle incl. equal-grid stop)', () => {
	const ids = [1, 2, 3, 4];
	it('forward: grid → first tile → … → last → back to grid', () => {
		expect(nextSpotlight(ids, null, 1)).toBe(1);
		expect(nextSpotlight(ids, 1, 1)).toBe(2);
		expect(nextSpotlight(ids, 3, 1)).toBe(4);
		expect(nextSpotlight(ids, 4, 1)).toBeNull(); // past the last tile → equal grid
	});
	it('backward is the reverse', () => {
		expect(nextSpotlight(ids, null, -1)).toBe(4);
		expect(nextSpotlight(ids, 4, -1)).toBe(3);
		expect(nextSpotlight(ids, 1, -1)).toBeNull(); // before the first → equal grid
	});
	it('REGRESSION: the equal grid is always reachable by cycling (the reported bug)', () => {
		let cur: number | null = 2;
		const seen: Array<number | null> = [];
		for (let i = 0; i < ids.length + 1; i++) { cur = nextSpotlight(ids, cur, 1); seen.push(cur); }
		expect(seen).toContain(null); // Alt+→ can reach the all-equal layout
	});
	it('an unknown current steps into the ring', () => {
		expect(nextSpotlight(ids, 999, 1)).toBe(1);
		expect(nextSpotlight(ids, 999, -1)).toBe(4);
	});
	it('no tiles → only the equal grid', () => {
		expect(nextSpotlight([], null, 1)).toBeNull();
		expect(nextSpotlight([], 5, 1)).toBeNull();
	});
});
