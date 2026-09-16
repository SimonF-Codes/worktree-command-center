import { describe, it, expect } from 'vitest';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, physicalKeyLabel, nextSpotlight, bestFitShape, cellsInTile, minTileSize, DEFAULT_CELL_METRICS, rawBand, autoBand, shapeForBand, autoShape, shapeFits, isLayoutMode, type CellMetrics } from '../src/terminals/bubble-layout';

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
		// Four tiles on a box that cannot give any of them 80x20: no tile goes below the minimum,
		// and the layout runs off the stage, which then scrolls.
		const r = settledLayout([1, 2, 3, 4], 900, 500, 8, { metrics: M });
		const min = minTileSize(M);
		for (const t of r) { expect(t.w).toBeGreaterThanOrEqual(min.w); expect(t.h).toBeGreaterThanOrEqual(min.h); }
		expect(Math.max(...r.map((t) => t.y + t.h))).toBeGreaterThan(500);        // scrolls, by design
	});
	it('when it must overflow, it overflows DOWNWARDS and keeps the tiles full-width', () => {
		// Scrolling down past full-width tiles beats scrolling sideways past half-width ones, and
		// once tiles are pinned at the minimum the scroll direction is all there is left to choose.
		const r = settledLayout([1, 2, 3, 4, 5, 6], 900, 800, 8, { metrics: M });
		expect(new Set(r.map((t) => t.x)).size).toBe(1);                          // one column
		expect(Math.max(...r.map((t) => t.x + t.w))).toBeLessThanOrEqual(900);    // …so no sideways scroll
		expect(Math.max(...r.map((t) => t.y + t.h))).toBeGreaterThan(800);
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

describe('autoBand — Auto follows the stage aspect', () => {
	it('narrow stacks, ultrawide splits, in between is a grid', () => {
		expect(rawBand(0.5)).toBe('rows');
		expect(rawBand(1.0)).toBe('grid');
		expect(rawBand(3.5)).toBe('columns');
	});
	it('with no previous band it just reads the aspect', () => {
		expect(autoBand(0.5, null)).toBe('rows');
		expect(autoBand(2.4, null)).toBe('columns');
	});
	it('HYSTERESIS: a wobble across a boundary smaller than the margin does not flip', () => {
		// Dragging a window edge around 0.8 — the raw band changes on every sample, the
		// applied band does not.
		for (const a of [0.81, 0.79, 0.78, 0.8, 0.76, 0.82]) expect(autoBand(a, 'grid')).toBe('grid');
		for (const a of [0.79, 0.81, 0.85, 0.87, 0.8]) expect(autoBand(a, 'rows')).toBe('rows');
		// …and the same around the ultrawide edge.
		for (const a of [2.21, 2.3, 2.4, 2.19]) expect(autoBand(a, 'grid')).toBe('grid');
		for (const a of [2.19, 2.05, 2.0, 2.25]) expect(autoBand(a, 'columns')).toBe('columns');
	});
	it('switches once the aspect clears the boundary by the margin', () => {
		expect(autoBand(0.71, 'grid')).toBe('rows');       // past 0.8 × 0.9
		expect(autoBand(2.43, 'grid')).toBe('columns');    // past 2.2 × 1.1
		expect(autoBand(0.89, 'rows')).toBe('grid');       // past 0.8 × 1.1
		expect(autoBand(1.97, 'columns')).toBe('grid');    // past 2.2 × 0.9
	});
	it('a jump straight across both bands lands on the far one, not the middle', () => {
		expect(autoBand(3.0, 'rows')).toBe('columns');
		expect(autoBand(0.4, 'columns')).toBe('rows');
	});
	it('is stable: re-applying a band to its own aspect never moves', () => {
		for (const a of [0.3, 0.6, 0.8, 1.2, 2.2, 2.6, 5]) {
			const b = autoBand(a, null);
			expect(autoBand(a, b)).toBe(b);
		}
	});
});

describe('shapeForBand', () => {
	it('columns is one row, rows is one column, grid searches', () => {
		expect(shapeForBand('columns', 4, 2000, 1000, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 4, rows: 1 });
		expect(shapeForBand('rows', 4, 2000, 1000, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 1, rows: 4 });
		expect(shapeForBand('grid', 4, 2000, 2000, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 2, rows: 2 });
	});
	it('a named band beats the box — Columns stays columns on a portrait stage', () => {
		expect(shapeForBand('columns', 4, 900, 2400, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 4, rows: 1 });
	});
});

describe('isLayoutMode', () => {
	it('accepts the five modes and nothing else', () => {
		for (const m of ['auto', 'grid', 'columns', 'rows', 'focus']) expect(isLayoutMode(m)).toBe(true);
		for (const m of ['', 'Grid', 'tiles', 7, null, undefined, {}]) expect(isLayoutMode(m)).toBe(false);
	});
});

describe('centeredLayout — the satellite edges come from the stage shape', () => {
	/** Every tile inside the stage, and no two tiles on top of each other. */
	const sane = (r: ReturnType<typeof centeredLayout>, W: number, H: number): void => {
		for (const t of r) {
			expect(t.w).toBeGreaterThan(0);
			expect(t.h).toBeGreaterThan(0);
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.x + t.w).toBeLessThanOrEqual(W);
			expect(t.y + t.h).toBeLessThanOrEqual(H);
		}
		for (let i = 0; i < r.length; i++) {
			for (let j = i + 1; j < r.length; j++) {
				const a = r[i]!, b = r[j]!;
				const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
				expect(overlaps).toBe(false);
			}
		}
	};

	it('PORTRAIT: satellites take top/bottom bands, so the centre keeps the whole width', () => {
		const r = centeredLayout([1, 2, 3, 4], 900, 2000, 8, 1);
		const c = r.find((t) => t.id === 1)!;
		expect(c.w).toBe(900 - 16);                                     // full width — no columns stolen
		for (const t of r) {
			if (t.id === 1) continue;
			expect(t.y + t.h <= c.y || t.y >= c.y + c.h).toBe(true);      // above or below, never beside
		}
		sane(r, 900, 2000);
	});

	it('the old round-robin put the first satellites in COLUMNS even on a portrait stage', () => {
		// Regression: with `order = [l, r, t, b]` and `i % 4`, tiles 2 and 3 became left and right
		// columns here, spending 40% of the scarce dimension. Nothing may sit beside the centre now.
		const r = centeredLayout([1, 2, 3], 700, 1800, 8, 1);
		const c = r.find((t) => t.id === 1)!;
		for (const t of r) {
			if (t.id === 1) continue;
			const beside = t.x + t.w <= c.x || t.x >= c.x + c.w;
			expect(beside).toBe(false);
		}
		sane(r, 700, 1800);
	});

	it('WIDE: satellites take left/right columns and the centre keeps the whole height', () => {
		const r = centeredLayout([1, 2, 3, 4], 3000, 1200, 8, 1);
		const c = r.find((t) => t.id === 1)!;
		expect(c.h).toBe(1200 - 16);
		for (const t of r) {
			if (t.id === 1) continue;
			expect(t.x + t.w <= c.x || t.x >= c.x + c.w).toBe(true);    // beside, never above/below
		}
		sane(r, 3000, 1200);
	});

	it('an explicit band overrides the aspect (Focus on a stage Auto would stack)', () => {
		const r = centeredLayout([1, 2], 900, 2000, 8, 1, { band: 'grid' });
		const c = r.find((t) => t.id === 1)!;
		const sat = r.find((t) => t.id === 2)!;
		expect(sat.x + sat.w <= c.x || sat.x >= c.x + c.w).toBe(true);  // a column, because we said so
	});

	it('the edge is capped so the centre never drops below a usable terminal', () => {
		// 1000x400 can just about seat an 80x20 centre with two satellite columns: the centre gets
		// exactly the minimum and the satellites get what is left, not a blind 20% each.
		const r = centeredLayout([1, 2, 3], 1000, 400, 8, 1);
		const c = r.find((t) => t.id === 1)!;
		expect(c.w).toBe(minTileSize(DEFAULT_CELL_METRICS).w);
		sane(r, 1000, 400);
	});

	it('when the stage cannot seat both, the centre keeps 60% instead of being squeezed out', () => {
		const W = 800, H = 300;
		const r = centeredLayout([1, 2, 3], W, H, 8, 1);
		const c = r.find((t) => t.id === 1)!;
		expect(c.w).toBeGreaterThan((W - 32) * 0.55);
		sane(r, W, H);
	});

	it('edge thickness is priced in character cells, not in a hardcoded 90px', () => {
		const focus = (m: CellMetrics): number => {
			const r = centeredLayout([1, 2, 3], 3000, 1200, 8, 1, { metrics: m, focus: true });
			return r.find((t) => t.id === 2)!.w;
		};
		const base = { ...DEFAULT_CELL_METRICS, chromeW: 10 };
		expect(focus(base)).toBe(Math.ceil(16 * base.cw + base.chromeW));
		expect(focus({ ...base, cw: base.cw * 2 })).toBe(Math.ceil(16 * base.cw * 2 + base.chromeW));
	});

	it('FOCUS keeps the satellites to a preview strip, so the centre is bigger than in Auto', () => {
		const box = [3000, 1200] as const;
		const auto = centeredLayout([1, 2, 3], box[0], box[1], 8, 1).find((t) => t.id === 1)!;
		const focus = centeredLayout([1, 2, 3], box[0], box[1], 8, 1, { focus: true }).find((t) => t.id === 1)!;
		expect(focus.w).toBeGreaterThan(auto.w);
		expect(focus.h).toBe(auto.h);
	});

	it('stays sane across a range of boxes and tile counts', () => {
		for (const [W, H] of [[600, 1600], [900, 900], [1920, 1080], [3440, 900], [500, 400]] as const) {
			for (let n = 1; n <= 7; n++) {
				const ids = Array.from({ length: n }, (_, i) => i + 1);
				sane(centeredLayout(ids, W, H, 8, 1), W, H);
			}
		}
	});
});

describe('autoShape — Auto does not scroll when it does not have to', () => {
	it("falls back to the grid when the band's own shape cannot seat the tiles", () => {
		// Six terminals on an ultrawide stage: the Columns band would pin them to six slivers at
		// the minimum and scroll, when 3x2 fits outright.
		const W = 3420, H = 1265;
		expect(shapeForBand('columns', 6, W, H, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 6, rows: 1 });
		expect(shapeFits(W, H, 8, { cols: 6, rows: 1 }, DEFAULT_CELL_METRICS)).toBe(false);
		const s = autoShape('columns', 6, W, H, 8, DEFAULT_CELL_METRICS);
		expect(s).toEqual({ cols: 3, rows: 2 });
		expect(shapeFits(W, H, 8, s, DEFAULT_CELL_METRICS)).toBe(true);
	});
	it('keeps the band when it fits — four terminals on the same ultrawide stay columns', () => {
		expect(autoShape('columns', 4, 3420, 1265, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 4, rows: 1 });
	});
	it('keeps the band when nothing fits — a portrait stage still stacks and scrolls', () => {
		const W = 1060, H = 1745;
		const s = autoShape('rows', 6, W, H, 8, DEFAULT_CELL_METRICS);
		expect(s).toEqual({ cols: 1, rows: 6 });                                  // full width, scroll down
		expect(shapeFits(W, H, 8, s, DEFAULT_CELL_METRICS)).toBe(false);
	});
	it('a NAMED mode never falls back — Columns means columns even when they scroll', () => {
		expect(shapeForBand('columns', 6, 3420, 1265, 8, DEFAULT_CELL_METRICS)).toEqual({ cols: 6, rows: 1 });
	});
});
