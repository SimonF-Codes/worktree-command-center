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

/** Past this multiple of the minimum, an axis stops earning credit. a terminal 160 columns wide is no
 *  more readable than one 120 wide; without the cap the score keeps trading one huge axis against the
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
 *  Shapes that clear the minimum outrank shapes that do not, and among those that do not, shapes
 *  that at least clear it in WIDTH outrank the rest. That is not a second rule bolted on: tiles
 *  below the minimum are held AT the minimum and the stage scrolls, so for those shapes the score
 *  is measuring a cell size that no longer happens — all that is left to choose between them is
 *  which way the stage has to scroll, and scrolling down past full-width tiles beats scrolling
 *  sideways past half-width ones. Without the ranking, six tiles on a half-width window come out
 *  as a 2x3 that scrolls BOTH ways instead of a single column that scrolls down.
 *
 *  This replaced `Math.ceil(Math.sqrt(n))`, which read only n: four tiles were a 2x2 grid on every
 *  screen there is, halving an already-narrow portrait width and wasting an ultrawide. */
export function bestFitShape(n: number, W: number, H: number, gap: number, m: CellMetrics = DEFAULT_CELL_METRICS): Shape {
	if (n <= 1) return { cols: 1, rows: 1 };
	const landscape = W >= H;
	const min = minTileSize(m);
	let best: Shape = { cols: 1, rows: n };
	let bestRank = -1;
	let bestScore = -Infinity;
	for (let cols = 1; cols <= n; cols++) {
		const s: Shape = { cols, rows: Math.ceil(n / cols) };
		const px = cellPx(W, H, gap, s);
		const rank = px.w < min.w ? 0 : px.h < min.h ? 1 : 2;
		const score = shapeScore(W, H, gap, s, m);
		const tied = rank === bestRank && Math.abs(score - bestScore) < 1e-9;
		if (rank > bestRank
			|| (rank === bestRank && score > bestScore + 1e-9)
			|| (tied && (landscape ? s.rows < best.rows : s.cols < best.cols))) {
			best = s;
			bestRank = rank;
			bestScore = score;
		}
	}
	return best;
}

/** What Simon picked for this workspace. Auto follows the window as it resizes; the other four
 *  are the escape hatch for when he knows better than the heuristic. */
export type LayoutMode = 'auto' | 'grid' | 'columns' | 'rows' | 'focus';

/** The three shapes Auto chooses between. Also what Grid/Columns/Rows name directly. */
export type LayoutBand = 'rows' | 'grid' | 'columns';

export const LAYOUT_OPTIONS: ReadonlyArray<{ value: LayoutMode; label: string; title: string }> = [
	{ value: 'auto', label: '⤢ Auto', title: 'Auto — follow the window: stacked rows when narrow, a best-fit grid in between, full-height columns when ultrawide. The spotlighted terminal still gets the big centre.' },
	{ value: 'grid', label: '▦ Grid', title: 'Grid — always an equal best-fit grid, even when a terminal is spotlighted.' },
	{ value: 'columns', label: '▥ Columns', title: 'Columns — always full-height columns, one per terminal.' },
	{ value: 'rows', label: '▤ Rows', title: 'Rows — always full-width rows, one per terminal.' },
	{ value: 'focus', label: '◎ Focus', title: 'Focus — the spotlighted terminal as large as it can be, the rest kept to preview strips at the edge.' },
];

export function isLayoutMode(v: unknown): v is LayoutMode {
	return typeof v === 'string' && LAYOUT_OPTIONS.some((o) => o.value === v);
}

/** Auto's aspect (W/H) bands: narrower than 0.8 stacks into rows, wider than 2.2 splits into
 *  columns, and everything in between gets the best-fit grid. */
export const AUTO_BAND_EDGES = { portrait: 0.8, wide: 2.2 } as const;

/** How far past an edge the aspect must travel before Auto changes its mind. Without this,
 *  dragging a window edge across a boundary flips the layout back and forth for the whole drag,
 *  which makes the feature actively unpleasant rather than merely imperfect. */
export const BAND_HYSTERESIS = 0.1;

/** The band an aspect falls in with no memory of where it came from. */
export function rawBand(aspect: number): LayoutBand {
	if (aspect < AUTO_BAND_EDGES.portrait) return 'rows';
	if (aspect > AUTO_BAND_EDGES.wide) return 'columns';
	return 'grid';
}

/** The band to use, given the one already on screen. Stays put until the aspect has cleared the
 *  current band's own edges by `margin`; once it has, the NEW aspect decides, so a jump straight
 *  from portrait to ultrawide lands on columns without stopping at grid. */
export function autoBand(aspect: number, prev: LayoutBand | null = null, margin: number = BAND_HYSTERESIS): LayoutBand {
	const next = rawBand(aspect);
	if (prev === null || prev === next) return next;
	const [lo, hi] = prev === 'rows' ? [0, AUTO_BAND_EDGES.portrait]
		: prev === 'grid' ? [AUTO_BAND_EDGES.portrait, AUTO_BAND_EDGES.wide]
			: [AUTO_BAND_EDGES.wide, Infinity];
	return aspect < lo * (1 - margin) || aspect > hi * (1 + margin) ? next : prev;
}

/** The grid shape a band asks for. Columns and Rows are the degenerate shapes the best-fit search
 *  would pick on an extreme box anyway — naming them is how Simon pins one down on any box. */
export function shapeForBand(band: LayoutBand, n: number, W: number, H: number, gap: number, m: CellMetrics = DEFAULT_CELL_METRICS): Shape {
	const count = Math.max(1, n);
	if (band === 'columns') return { cols: count, rows: 1 };
	if (band === 'rows') return { cols: 1, rows: count };
	return bestFitShape(count, W, H, gap, m);
}

/** Does this shape seat every tile at the minimum without the stage having to scroll? */
export function shapeFits(W: number, H: number, gap: number, s: Shape, m: CellMetrics = DEFAULT_CELL_METRICS): boolean {
	const px = cellPx(W, H, gap, s);
	const min = minTileSize(m);
	return px.w >= min.w && px.h >= min.h;
}

/** The shape Auto uses: its band's, unless that band cannot seat the tiles at the minimum while
 *  the best-fit grid can. Six terminals on an ultrawide stage are the case — the Columns band
 *  would pin them to six 80-column slivers and scroll, when 3x2 fits comfortably without
 *  scrolling at all, and Auto exists to pick the best layout for the box.
 *
 *  A NAMED mode (Grid/Columns/Rows) never falls back: it is the escape hatch for when Simon knows
 *  better than the heuristic, so it does what it says even when the result has to scroll. */
export function autoShape(band: LayoutBand, n: number, W: number, H: number, gap: number, m: CellMetrics = DEFAULT_CELL_METRICS): Shape {
	const preferred = shapeForBand(band, n, W, H, gap, m);
	if (band === 'grid' || shapeFits(W, H, gap, preferred, m)) return preferred;
	const grid = bestFitShape(Math.max(1, n), W, H, gap, m);
	return shapeFits(W, H, gap, grid, m) ? grid : preferred;
}

export interface SettledOpts {
	metrics?: CellMetrics;
	/** Override the shape search (used by the Columns/Rows layout modes). */
	shape?: Shape;
	/** Shape for this band; ignored when `shape` is given. Defaults to the best-fit grid. */
	band?: LayoutBand;
}

/** Adaptive grid filling the stage, shaped by the box and not just by the tile count. */
export function settledLayout(ids: number[], W: number, H: number, gap: number, opts: SettledOpts = {}): Rect[] {
	const n = ids.length;
	if (n === 0) return [];
	const m = opts.metrics ?? DEFAULT_CELL_METRICS;
	const shape = opts.shape ?? shapeForBand(opts.band ?? 'grid', n, W, H, gap, m);
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

export interface CenteredOpts {
	metrics?: CellMetrics;
	/** Which edges the satellites take: 'rows' (a stage narrow enough that Auto would stack it)
	 *  puts them in top/bottom bands, anything wider puts them in left/right columns. Defaults to
	 *  the raw stage aspect. */
	band?: LayoutBand;
	/** Focus mode — hold the satellites to the thinnest strip that is still a readable preview so
	 *  the centre is as large as the stage allows. */
	focus?: boolean;
}

/** What a satellite has to show to be worth putting on screen. It is a PREVIEW, not a terminal
 *  anyone types into — terminal-tile only refits the PTY of the CENTERED tile — so the bar is
 *  "can I see what this session is doing", not the 80x20 a working terminal needs. Still in
 *  character cells, so it tracks the font instead of being a magic 90px that a narrow stage
 *  silently overflowed. */
const SAT_MIN_COLS = 16;
const SAT_MIN_ROWS = 4;

/** What one satellite edge asks for when the stage can afford it. */
const SAT_FRACTION = 0.2;

/** Thickness of one satellite edge along an axis of length `total` with `sides` edges in use.
 *
 *  Never a sliver below a readable preview, and never so thick that the centre drops below a
 *  usable terminal — the old `max(90, 20%)` had a floor but no ceiling, which is exactly how a
 *  narrow stage ended up with satellites eating the centre. When the axis is too short for both,
 *  the centre keeps 60% of it rather than being squeezed out by its own satellites. */
function edgeThickness(total: number, gap: number, sides: number, satMin: number, centerMin: number, focus: boolean): number {
	if (sides <= 0) return 0;
	const avail = total - gap * (sides + 2);                                  // tile pixels, gutters paid
	const want = focus ? satMin : Math.max(satMin, Math.floor(total * SAT_FRACTION));
	const room = Math.floor((avail - centerMin) / sides);                     // …keeping the centre usable
	return room >= satMin ? Math.min(want, room) : Math.max(0, Math.floor((avail * 0.4) / sides));
}

/** Big centered tile that fills all space not taken by satellites.
 *
 *  Which edges the satellites take is decided by the SHAPE of the stage, not by their index: on a
 *  narrow stage they go into top/bottom bands, on a wide one into left/right columns. The old
 *  round-robin (`buckets[order[i % 4]]`, order l,r,t,b) put the first two satellites in left and
 *  right columns on every stage — on a portrait monitor that spent 40% of the scarce dimension
 *  before the centre got any. The centre still grows into any edge with no satellites, so it is
 *  full-height with one or two others and never leaves gaps. */
export function centeredLayout(ids: number[], W: number, H: number, gap: number, centeredId: number, opts: CenteredOpts = {}): Rect[] {
	const m = opts.metrics ?? DEFAULT_CELL_METRICS;
	const band = opts.band ?? rawBand(W / Math.max(1, H));
	if (!ids.includes(centeredId)) return settledLayout(ids, W, H, gap, { metrics: m, band });
	const others = ids.filter((id) => id !== centeredId);

	// Lone tile: fill the whole stage.
	if (others.length === 0) {
		return [{ id: centeredId, x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap }];
	}

	const buckets: Record<'l' | 'r' | 't' | 'b', number[]> = { l: [], r: [], t: [], b: [] };
	// Bottom first on a narrow stage (the centre keeps the top), left first on a wide one.
	const edges: Array<'l' | 'r' | 't' | 'b'> = band === 'rows' ? ['b', 't'] : ['l', 'r'];
	others.forEach((id, i) => buckets[edges[i % edges.length]!]!.push(id));

	const min = minTileSize(m);
	const satMinW = Math.ceil(SAT_MIN_COLS * m.cw + m.chromeW);
	const satMinH = Math.ceil(SAT_MIN_ROWS * m.ch + m.chromeH);
	const colW = edgeThickness(W, gap, (buckets.l.length ? 1 : 0) + (buckets.r.length ? 1 : 0), satMinW, min.w, opts.focus ?? false);
	const bandH = edgeThickness(H, gap, (buckets.t.length ? 1 : 0) + (buckets.b.length ? 1 : 0), satMinH, min.h, opts.focus ?? false);
	const leftX = gap;
	const rightX = W - gap - colW;
	const topY = gap;
	const botY = H - gap - bandH;

	// The center occupies everything between whichever edges actually hold satellites.
	const cx = buckets.l.length ? gap + colW + gap : gap;
	const rightLimit = buckets.r.length ? rightX - gap : W - gap;
	const cw = Math.max(1, rightLimit - cx);
	const cy = buckets.t.length ? gap + bandH + gap : gap;
	const botLimit = buckets.b.length ? botY - gap : H - gap;
	const ch = Math.max(1, botLimit - cy);

	const out: Rect[] = [{ id: centeredId, x: cx, y: cy, w: cw, h: ch }];

	// Left/right columns span the full height; top/bottom bands span the center's width.
	const vert = (arr: number[], x: number): void => {
		const n = arr.length;
		if (!n) return;
		const h = Math.floor((H - gap * (n + 1)) / n);
		arr.forEach((id, i) => out.push({ id, x, y: gap + i * (h + gap), w: colW, h }));
	};
	const horiz = (arr: number[], y: number): void => {
		const n = arr.length;
		if (!n) return;
		const w = Math.floor((cw - gap * (n - 1)) / n);
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
