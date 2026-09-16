export interface Rect { id: number; x: number; y: number; w: number; h: number; }

/** Below this a terminal is not a terminal any more: the Claude Code TUI wraps badly under 80
 *  columns, and under ~20 rows the input box and context line fall off the bottom. Everything
 *  here is expressed against these two numbers rather than against pixels. */
export const MIN_TERM_COLS = 80;
export const MIN_TERM_ROWS = 20;

/** What one character cell costs in pixels, and what the tile chrome around it costs, MEASURED
 *  from a live xterm rather than assumed.
 *
 *  A pixel floor ("a tile is usable at 570px") is only true for one font size on one display —
 *  the layout that is right at 14px on a 1080p screen is wrong at 20px or on a 4K panel, which
 *  is exactly the class of bug this module exists to stop making. So the caller measures the
 *  live terminal and injects the result; nothing in here touches the DOM. */
export interface CellMetrics {
	cw: number;        // px per character column
	ch: number;        // px per character row
	chromeW: number;   // px of the tile box that is not character cells, horizontally
	chromeH: number;   // …and vertically (header, borders, padding, scrollbar gutter)
	minCols: number;
	minRows: number;
}

/** The half a live terminal can report; the minimums are the caller's policy, not the font's. */
export type TileCellMetrics = Pick<CellMetrics, 'cw' | 'ch' | 'chromeW' | 'chromeH'>;

/** Only for before any terminal has rendered (a tab holding just a journal tile, or the very
 *  first layout): a 12px monospace at 1×, matching TerminalTile's `new Terminal({ fontSize: 12 })`
 *  and the .cos-term-head/.cos-term-body chrome. Replaced by real metrics as soon as one exists. */
export const DEFAULT_CELL_METRICS: CellMetrics = { cw: 7, ch: 16, chromeW: 10, chromeH: 33, minCols: MIN_TERM_COLS, minRows: MIN_TERM_ROWS };

/** How many character columns/rows a tile of this pixel size can actually show. */
export function cellsInTile(w: number, h: number, m: CellMetrics): { cols: number; rows: number } {
	return {
		cols: Math.max(0, Math.floor((w - m.chromeW) / Math.max(1, m.cw))),
		rows: Math.max(0, Math.floor((h - m.chromeH) / Math.max(1, m.ch))),
	};
}

/** The smallest tile that is still a usable terminal, in pixels for THIS font and display. */
export function minTileSize(m: CellMetrics): { w: number; h: number } {
	return { w: Math.ceil(m.minCols * m.cw + m.chromeW), h: Math.ceil(m.minRows * m.ch + m.chromeH) };
}

export interface Shape { cols: number; rows: number; }

function cellPx(W: number, H: number, gap: number, s: Shape): { w: number; h: number } {
	return { w: Math.floor((W - gap * (s.cols + 1)) / s.cols), h: Math.floor((H - gap * (s.rows + 1)) / s.rows) };
}

/** Past this multiple of the minimum, an axis stops earning credit. 160 columns is no more
 *  readable than 160 columns; without the cap the score keeps trading one huge axis against the
 *  other on a big screen and two tiles on a 16:9 stage come out stacked into letterbox strips
 *  instead of side by side. Twice the minimum is "comfortable"; beyond it the tie-break decides. */
const HEADROOM_CAP = 2;

/** How good a shape is on this box: the WORSE of its two axes, each measured against the minimum
 *  it has to clear. 1.0 means "exactly usable", above is headroom, below is how far short it
 *  falls. Taking the minimum of the two ratios is the whole trick — a shape that buys columns by
 *  starving rows scores as badly as the starved axis, so portrait boxes pick tall-thin shapes and
 *  ultrawide boxes pick short-wide ones without either being a special case anywhere. */
function shapeScore(W: number, H: number, gap: number, s: Shape, m: CellMetrics): number {
	const px = cellPx(W, H, gap, s);
	const c = cellsInTile(px.w, px.h, m);
	const cols = Math.min(HEADROOM_CAP, c.cols / Math.max(1, m.minCols));
	const rows = Math.min(HEADROOM_CAP, c.rows / Math.max(1, m.minRows));
	return Math.min(cols, rows);
}

/** Pick the (cols, rows) that maximises the smallest resulting cell, measured in CHARACTER CELLS.
 *  Candidates are every column count 1..n with rows = ceil(n / cols), so cols * rows >= n always
 *  and at most one row is short. Ties break toward fewer rows on a landscape box and fewer columns
 *  on a portrait one — i.e. toward spending the abundant dimension.
 *
 *  This replaced `Math.ceil(Math.sqrt(n))`, which read only n: four tiles were a 2x2 grid on every
 *  screen there is, halving an already-narrow portrait width and wasting an ultrawide. */
export function bestFitShape(n: number, W: number, H: number, gap: number, m: CellMetrics = DEFAULT_CELL_METRICS): Shape {
	if (n <= 1) return { cols: 1, rows: 1 };
	const landscape = W >= H;
	let best: Shape = { cols: 1, rows: n };
	let bestScore = -Infinity;
	for (let cols = 1; cols <= n; cols++) {
		const s: Shape = { cols, rows: Math.ceil(n / cols) };
		const score = shapeScore(W, H, gap, s, m);
		const tied = Math.abs(score - bestScore) < 1e-9;
		if (score > bestScore + 1e-9 || (tied && (landscape ? s.rows < best.rows : s.cols < best.cols))) {
			best = s;
			bestScore = Math.max(score, bestScore);
		}
	}
	return best;
}

export interface SettledOpts {
	metrics?: CellMetrics;
	/** Override the shape search (used by the Columns/Rows layout modes). */
	shape?: Shape;
}

/** Adaptive grid filling the stage, shaped by the box and not just by the tile count. */
export function settledLayout(ids: number[], W: number, H: number, gap: number, opts: SettledOpts = {}): Rect[] {
	const n = ids.length;
	if (n === 0) return [];
	const m = opts.metrics ?? DEFAULT_CELL_METRICS;
	const shape = opts.shape ?? bestFitShape(n, W, H, gap, m);
	const cols = Math.max(1, shape.cols);
	const rows = Math.max(1, shape.rows);
	const min = minTileSize(m);
	// Honour the minimum instead of shrinking past it. When n tiles genuinely cannot fit at
	// 80x20 the tiles keep that size and the stage scrolls (.cos-terminals-stage is overflow:auto
	// for exactly this): twelve unreadable slivers is not a layout, and a terminal below the
	// minimum is the failure this whole module exists to prevent.
	const tw = Math.max(min.w, Math.floor((W - gap * (cols + 1)) / cols));
	const th = Math.max(min.h, Math.floor((H - gap * (rows + 1)) / rows));
	return ids.map((id, i) => {
		const c = i % cols;
		const r = Math.floor(i / cols);
		return { id, x: gap + c * (tw + gap), y: gap + r * (th + gap), w: tw, h: th };
	});
}

/** Big centered tile that fills all space not taken by satellites. Satellites ring the
 *  edges (left/right columns first, then top/bottom bands); the center grows into any
 *  edge that has no satellites, so it's full-height with 1-2 others and never leaves gaps. */
export function centeredLayout(ids: number[], W: number, H: number, gap: number, centeredId: number): Rect[] {
	if (!ids.includes(centeredId)) return settledLayout(ids, W, H, gap);
	const others = ids.filter((id) => id !== centeredId);

	// Lone tile: fill the whole stage.
	if (others.length === 0) {
		return [{ id: centeredId, x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap }];
	}

	const buckets: Record<'l' | 'r' | 't' | 'b', number[]> = { l: [], r: [], t: [], b: [] };
	const order: Array<'l' | 'r' | 't' | 'b'> = ['l', 'r', 't', 'b'];
	others.forEach((id, i) => buckets[order[i % 4]!].push(id));

	const colW = Math.max(90, Math.floor(W * 0.2));
	const bandH = Math.max(60, Math.floor(H * 0.2));
	const leftX = gap;
	const rightX = W - gap - colW;
	const topY = gap;
	const botY = H - gap - bandH;

	// The center occupies everything between whichever edges actually hold satellites.
	const cx = buckets.l.length ? gap + colW + gap : gap;
	const rightLimit = buckets.r.length ? rightX - gap : W - gap;
	const cw = Math.max(120, rightLimit - cx);
	const cy = buckets.t.length ? gap + bandH + gap : gap;
	const botLimit = buckets.b.length ? botY - gap : H - gap;
	const ch = Math.max(120, botLimit - cy);

	const out: Rect[] = [{ id: centeredId, x: cx, y: cy, w: cw, h: ch }];

	// Left/right columns span the full height; top/bottom bands span the center's width.
	const vert = (arr: number[], x: number): void => {
		const m = arr.length;
		if (!m) return;
		const h = Math.floor((H - gap * (m + 1)) / m);
		arr.forEach((id, i) => out.push({ id, x, y: gap + i * (h + gap), w: colW, h }));
	};
	const horiz = (arr: number[], y: number): void => {
		const m = arr.length;
		if (!m) return;
		const w = Math.floor((cw - gap * (m - 1)) / m);
		arr.forEach((id, i) => out.push({ id, x: cx + i * (w + gap), y, w, h: bandH }));
	};
	vert(buckets.l, leftX);
	vert(buckets.r, rightX);
	horiz(buckets.t, topY);
	horiz(buckets.b, botY);
	return out;
}

/** Tile shortcut label: F1..F12, then A, B, … */
export function keyForIndex(i: number): string {
	return i < 12 ? `F${i + 1}` : String.fromCharCode(65 + (i - 12));
}

export function keyToIndex(key: string): number | null {
	const m = /^F(\d{1,2})$/.exec(key);
	if (m) {
		const n = parseInt(m[1]!, 10);
		return n >= 1 && n <= 12 ? n - 1 : null;
	}
	if (/^[A-Z]$/.test(key)) return 12 + (key.charCodeAt(0) - 65);
	return null;
}

/** Normalize a KeyboardEvent into the label keyToIndex expects — "F1".."F12" or a bare letter.
 *  Deliberately prefers `.code` (physical key position, e.g. "KeyL") over `.key` for letters:
 *  on macOS, holding Option/Alt COMPOSES most letters into accented/special characters via
 *  `.key` (Option+L -> "¬", Option+C -> "ç", …) since that's the same modifier the OS uses for
 *  dead-key input — `.key` alone is unusable for an Alt+<letter> shortcut on Mac. `.code` is
 *  layout- and modifier-independent, so it survives regardless of what Option composed. Function
 *  keys aren't subject to this (no accent composition on F1-F12), so `.key` is fine for those. */
export function physicalKeyLabel(e: { key: string; code: string }): string {
	if (/^F\d{1,2}$/.test(e.key)) return e.key;
	const m = /^Key([A-Z])$/.exec(e.code);
	if (m) return m[1]!;
	return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Alt+←/→ spotlight cycle across every tile PLUS an "equal grid" stop (null). Given the
 *  current center (or null = equal grid) and a direction, return the next position in the ring
 *  [id0, id1, …, idN, null]. Unlike the ready-queue cycle this is independent of which tiles
 *  are idle, so it can always reach the equal grid — including when every terminal is thinking
 *  (the case where the ready stack is empty and the old cycle had nothing to move). */
export function nextSpotlight(ids: number[], current: number | null, dir: 1 | -1): number | null {
	const ring: Array<number | null> = [...ids, null];
	const i = ring.indexOf(current);
	const cur = i === -1 ? ring.length - 1 : i; // unknown current → treat as the grid slot
	const next = (cur + dir + ring.length) % ring.length;
	return ring[next]!;
}
