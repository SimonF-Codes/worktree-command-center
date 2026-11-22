import { HiddenOutputBuffer } from './hidden-buffer';

/** How a tile's PTY output reaches xterm. Only the CENTERED tile parses in real time ('live');
 *  visible satellites batch on a short cadence and hidden / workspace-detached tiles on a slow
 *  one — several sessions streaming at once otherwise starve the renderer's event loop
 *  (measured as continuous heartbeat 'gap' stalls, 2026-07-22). */
export type OutputMode = 'live' | 'visible' | 'suspended';

/** Flush cadence per batching mode. */
export const FLUSH_CADENCE_MS: Record<Exclude<OutputMode, 'live'>, number> = { visible: 300, suspended: 2000 };

/** Where drained output goes: the terminal, and the recovery for a window that overflowed. */
export interface PacerSink {
	/** Hand data to the terminal. `parsed` fires once it (and everything written before it) has
	 *  reached the screen buffer — xterm parses asynchronously, so a write is not yet readable. */
	write(data: string, parsed?: () => void): void;
	/** Ask the PTY to re-emit the current screen (TerminalTile: a one-row resize bounce). */
	nudge(): void;
}

export interface PacerTimers {
	setInterval(fn: () => void, ms: number): number;
	clearInterval(id: number): void;
}

/** The output-pacing state machine TerminalTile used to carry inline, lifted out so the timing
 *  can be tested without xterm or a PTY. The tile supplies the sink and the timers; nothing here
 *  touches the DOM. */
export class OutputPacer {
	private mode: OutputMode = 'live';
	private timer: number | null = null;

	constructor(
		private readonly sink: PacerSink,
		private readonly timers: PacerTimers,
		private readonly buf: HiddenOutputBuffer = new HiddenOutputBuffer(),
	) {}

	get current(): OutputMode { return this.mode; }

	/** Re-pace output on state edges only. Every boundary drains what the old cadence left
	 *  pending (so entering 'live' shows the current screen); batching modes install their timer. */
	setMode(mode: OutputMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.stopTimer();
		this.flush();
		if (mode !== 'live') this.timer = this.timers.setInterval(() => this.flush(), FLUSH_CADENCE_MS[mode]);
	}

	/** Route session output to the sink — or, in a batching mode, into the pending buffer. */
	write(data: string): void {
		if (this.mode !== 'live') this.buf.push(data);
		else this.sink.write(data);
	}

	/** Drain the pending window. A dropped window means the tile flooded past the cap — its bytes
	 *  are stale alternate-screen frames, so instead of parsing a partial tail we ask the PTY to
	 *  re-emit the CURRENT screen. */
	flush(): void {
		const { data, dropped } = this.buf.takeAll();
		if (dropped) this.sink.nudge();
		else if (data) this.sink.write(data);
	}

	/** Read the screen through `readScreen`, after handing the terminal whatever is pending —
	 *  otherwise a batching tile is read up to one whole cadence stale. Synchronous, so the bytes
	 *  drained by THIS call are queued but not yet parsed (see PacerSink.write): a sync reader
	 *  sees them one parse tick later instead of one cadence later. A reader that must see its
	 *  own just-typed echo awaits `settled()` first. */
	read<T>(readScreen: () => T): T {
		this.drainForRead();
		return readScreen();
	}

	/** Drain what is pending and resolve once the terminal has parsed it (and everything queued
	 *  before it), so the next read reflects every byte the session has produced so far. */
	settled(): Promise<void> {
		this.drainForRead();
		// An empty write's callback fires after every earlier write has been parsed.
		return new Promise((resolve) => this.sink.write('', resolve));
	}

	/** The drain a read does. It never nudges: reads come from timers floor-wide (the ~1s
	 *  spotlight tick, the 2s phone feed), and a getter must not resize a PTY. A window that
	 *  overflowed is left as it is, dropped flag and all, for the cadence timer or the next mode
	 *  boundary to recover with its one nudge, as before. That recovery discards those bytes
	 *  anyway, so the read sees the same screen it would have without the drain. */
	private drainForRead(): void {
		if (this.buf.dropped) return;
		const { data } = this.buf.takeAll();
		if (data) this.sink.write(data);
	}

	/** Discard pending output (session restart / reset): stale bytes must not replay. */
	clear(): void { this.buf.clear(); }

	/** Teardown: stop the cadence timer and discard pending output. */
	dispose(): void {
		this.stopTimer();
		this.buf.clear();
	}

	private stopTimer(): void {
		if (this.timer !== null) { this.timers.clearInterval(this.timer); this.timer = null; }
	}
}
