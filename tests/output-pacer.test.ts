import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputPacer, type PacerSink } from '../src/terminals/output-pacer';
import { HiddenOutputBuffer } from '../src/terminals/hidden-buffer';
import { looksDelivered } from '../src/terminals/prompt-detect';

/** A stand-in for xterm: like the real Terminal.write, data reaches `screen` only when the parser
 *  runs later (never inside the write call), in write order, and each write's callback fires once
 *  it has been parsed. (Parsed on a microtask rather than xterm's 0ms timeout: under fake timers a
 *  0ms timeout scheduled from inside a timer tick is not reliably run by the next advance.) */
function fakeTerm() {
	const term = { screen: '', nudges: 0, writes: [] as string[] };
	const sink: PacerSink = {
		write(data, parsed) {
			term.writes.push(data);
			void Promise.resolve().then(() => { term.screen += data; parsed?.(); });
		},
		nudge() { term.nudges++; },
	};
	return { term, sink };
}

const timers = {
	setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
	clearInterval: (id: number) => clearInterval(id),
};

/** The tail of TerminalTile.deliverLine: the echo is on its way, so drain, wait for the parse,
 *  and only then ask whether the text is on screen. */
async function deliveredCheck(pacer: OutputPacer, term: { screen: string }, text: string): Promise<boolean> {
	await pacer.settled();
	return looksDelivered(pacer.read(() => term.screen), text);
}

describe('OutputPacer', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('a suspended tile: the echo of a just-typed line is readable well under the 2s cadence', async () => {
		const { term, sink } = fakeTerm();
		const pacer = new OutputPacer(sink, timers);
		pacer.setMode('suspended'); // the cadence timer's next flush is a full 2s away
		const text = 'Read the brief at /tmp/brief.md and follow it exactly.';
		pacer.write(`> ${text}\r\n`); // the session echoes the line deliverLine typed
		await vi.advanceTimersByTimeAsync(1400); // deliverLine reads 250 + 650 + 500 ms after typing
		const check = deliveredCheck(pacer, term, text);
		await vi.advanceTimersByTimeAsync(0);
		expect(await check).toBe(true);
	});

	it('the cadence timer phase no longer matters: delivered whenever the line was typed', async () => {
		const text = 'a message that must land exactly once';
		for (let phase = 0; phase < 2000; phase += 100) {
			const { term, sink } = fakeTerm();
			const pacer = new OutputPacer(sink, timers);
			pacer.setMode('suspended');
			await vi.advanceTimersByTimeAsync(phase);
			pacer.write(text);
			await vi.advanceTimersByTimeAsync(1400);
			const check = deliveredCheck(pacer, term, text);
			await vi.advanceTimersByTimeAsync(0);
			expect(await check, `typed ${phase}ms into the cadence`).toBe(true);
			pacer.dispose();
		}
	});

	it('a synchronous read alone is NOT enough: xterm has not parsed what it was just handed', async () => {
		const { term, sink } = fakeTerm();
		const pacer = new OutputPacer(sink, timers);
		pacer.setMode('suspended');
		pacer.write('echo of the brief');
		await vi.advanceTimersByTimeAsync(1400);
		expect(looksDelivered(pacer.read(() => term.screen), 'echo of the brief')).toBe(false);
		await vi.advanceTimersByTimeAsync(0); // one parse tick later it is there
		expect(looksDelivered(pacer.read(() => term.screen), 'echo of the brief')).toBe(true);
	});

	it('read() hands pending output to the terminal before reading', () => {
		const { term, sink } = fakeTerm();
		const pacer = new OutputPacer(sink, timers);
		pacer.setMode('suspended');
		pacer.write('pending');
		pacer.read(() => term.screen);
		expect(term.writes).toEqual(['pending']);
	});

	it('a read never nudges, and leaves an overflowed window for the timer to recover once', async () => {
		const { term, sink } = fakeTerm();
		const pacer = new OutputPacer(sink, timers, new HiddenOutputBuffer(10));
		pacer.setMode('suspended');
		pacer.write('x'.repeat(11)); // overflow: the window is dropped
		pacer.read(() => term.screen);
		pacer.read(() => term.screen);
		void pacer.settled();
		expect(term.nudges).toBe(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(term.nudges).toBe(1);
	});

	it('live mode writes straight through; mode boundaries drain', () => {
		const { term, sink } = fakeTerm();
		const pacer = new OutputPacer(sink, timers);
		pacer.write('live');
		pacer.setMode('visible');
		pacer.write('batched');
		expect(term.writes).toEqual(['live']);
		pacer.setMode('live');
		expect(term.writes).toEqual(['live', 'batched']);
	});
});
