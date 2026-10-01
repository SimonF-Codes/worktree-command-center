import { describe, it, expect } from 'vitest';
import type { ProcRow } from '../src/terminals/process-snapshot';
import type { ServiceSnapshot } from '../src/terminals/system-memory';
import { ServiceCache, servicesStale, SERVICE_MAX_AGE_MS, SERVICE_MIN_AGE_MS } from '../src/terminals/service-snapshot';

const host = (pid: number): ProcRow => ({ pid, ppid: 1, name: 'svchost.exe', rssBytes: 1 });
const snap: ServiceSnapshot = { services: [{ name: 'DPS', displayName: 'DPS', pid: 10, pathName: null }], wslDistros: [] };
const T0 = 1_000_000;

describe('servicesStale', () => {
	it('asks when it has never asked', () => {
		expect(servicesStale([], null, null, T0)).toBe(true);
	});

	it('does not ask again inside the floor, even for an svchost it has never heard of', () => {
		expect(servicesStale([host(10), host(11)], snap, T0, T0 + SERVICE_MIN_AGE_MS - 1)).toBe(false);
	});

	it('asks again past the floor when an unknown svchost appears — a service started', () => {
		expect(servicesStale([host(10), host(11)], snap, T0, T0 + SERVICE_MIN_AGE_MS)).toBe(true);
		expect(servicesStale([host(10)], snap, T0, T0 + SERVICE_MIN_AGE_MS)).toBe(false);
	});

	it('asks again unconditionally once the answer is old', () => {
		expect(servicesStale([host(10)], snap, T0, T0 + SERVICE_MAX_AGE_MS)).toBe(true);
	});
});

describe('ServiceCache', () => {
	function build() {
		let now = T0;
		let calls = 0;
		let answer: ServiceSnapshot | null = snap;
		const cache = new ServiceCache(async () => { calls++; return answer; }, () => now);
		return {
			cache,
			calls: () => calls,
			advance: (ms: number) => { now += ms; },
			answer: (a: ServiceSnapshot | null) => { answer = a; },
		};
	}

	it('asks once, then serves the cached answer while it is fresh', async () => {
		const t = build();
		expect(await t.cache.refresh([host(10)])).toBe(snap);
		expect(await t.cache.refresh([host(10)])).toBe(snap);
		expect(t.calls()).toBe(1);
	});

	it('concurrent refreshes share one query', async () => {
		const t = build();
		await Promise.all([t.cache.refresh([]), t.cache.refresh([]), t.cache.refresh([], true)]);
		expect(t.calls()).toBe(1);
	});

	it('force (the ⟳ button) asks even when fresh', async () => {
		const t = build();
		await t.cache.refresh([]);
		await t.cache.refresh([], true);
		expect(t.calls()).toBe(2);
	});

	it('a failed query keeps the previous answer rather than blanking every service name', async () => {
		const t = build();
		await t.cache.refresh([]);
		t.answer(null);
		expect(await t.cache.refresh([], true)).toBe(snap);
	});

	it('clear() drops the answer, so reopening the view asks afresh', async () => {
		const t = build();
		await t.cache.refresh([]);
		t.cache.clear();
		expect(t.cache.latest()).toBeNull();
		await t.cache.refresh([]);
		expect(t.calls()).toBe(2);
	});

	it('an answer landing after clear() is discarded, not resurrected', async () => {
		const t = build();
		const pending = t.cache.refresh([]);
		t.cache.clear();
		expect(await pending).toBeNull();
		expect(t.cache.latest()).toBeNull();
	});
});
