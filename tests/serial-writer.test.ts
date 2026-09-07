import { describe, it, expect } from 'vitest';
import { SerialWriter } from '../src/serial-writer';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SerialWriter', () => {
	it('runs jobs one at a time, in push order', async () => {
		const w = new SerialWriter();
		const order: string[] = [];
		const job = (id: string, delay: number) => async (): Promise<void> => {
			order.push(`${id}:start`);
			await tick(delay);
			order.push(`${id}:end`);
		};
		// a is slow, b is fast: without serialization b would finish first.
		const pa = w.push(job('a', 30));
		const pb = w.push(job('b', 0));
		await Promise.all([pa, pb]);
		expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
	});

	it('lets the LAST queued write win — the read-modify-write race this exists to stop', async () => {
		const w = new SerialWriter();
		let stored = { theme: 'default', repos: 0 };
		// Each job reads inside itself, so it sees the previous job's result, not a stale snapshot.
		const write = (patch: Partial<typeof stored>) => (): Promise<void> => {
			const fresh = { ...stored };
			return tick(5).then(() => { stored = { ...fresh, ...patch }; });
		};
		await Promise.all([w.push(write({ theme: 'iris' })), w.push(write({ repos: 3 }))]);
		// Unserialized, the second read would have missed theme:'iris' and clobbered it back.
		expect(stored).toEqual({ theme: 'iris', repos: 3 });
	});

	it('a throwing job does not wedge the ones behind it', async () => {
		const w = new SerialWriter();
		const done: string[] = [];
		const bad = w.push(async () => { throw new Error('disk full'); });
		const good = w.push(async () => { done.push('ran'); });
		await expect(bad).resolves.toBeUndefined(); // swallowed, not rejected
		await good;
		expect(done).toEqual(['ran']);
	});

	it('idle() resolves once the queue drains', async () => {
		const w = new SerialWriter();
		let finished = false;
		void w.push(async () => { await tick(10); finished = true; });
		await w.idle();
		expect(finished).toBe(true);
	});
});
