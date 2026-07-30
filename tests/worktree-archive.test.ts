import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
	normalizeSweepPolicy, DEFAULT_SWEEP_POLICY, shouldAutoArchive, latestActivity,
	timeStamp, archiveBaseName, archiveDirFor, humanBytes, parseManifest, safeJoin,
	type SweepCandidate, type ArchiveManifest,
} from '../src/terminals/worktree-archive';

const DAY = 86_400_000;

describe('normalizeSweepPolicy', () => {
	it('defaults anything missing or malformed', () => {
		expect(normalizeSweepPolicy(undefined)).toEqual(DEFAULT_SWEEP_POLICY);
		expect(normalizeSweepPolicy('nonsense')).toEqual(DEFAULT_SWEEP_POLICY);
		expect(normalizeSweepPolicy({ enabled: false, maxAgeDays: 30 })).toEqual({ enabled: false, maxAgeDays: 30 });
	});

	it('floors a nonsense age at the default so a typo can never mean "archive everything now"', () => {
		expect(normalizeSweepPolicy({ maxAgeDays: 0 }).maxAgeDays).toBe(DEFAULT_SWEEP_POLICY.maxAgeDays);
		expect(normalizeSweepPolicy({ maxAgeDays: -5 }).maxAgeDays).toBe(DEFAULT_SWEEP_POLICY.maxAgeDays);
		expect(normalizeSweepPolicy({ maxAgeDays: NaN }).maxAgeDays).toBe(DEFAULT_SWEEP_POLICY.maxAgeDays);
		expect(normalizeSweepPolicy({ maxAgeDays: '' }).maxAgeDays).toBe(DEFAULT_SWEEP_POLICY.maxAgeDays);
		expect(normalizeSweepPolicy({ maxAgeDays: 7.9 }).maxAgeDays).toBe(7); // fractional days floor
	});
});

describe('shouldAutoArchive', () => {
	const now = 1_800_000_000_000;
	const policy = { enabled: true, maxAgeDays: 7 };
	const base = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
		branch: 'wt/main-1', path: '/p/wt-main-1', hasTerminal: false, lastActivity: now - 8 * DAY, ...over,
	});

	it('archives an unowned worktree past the age threshold', () => {
		expect(shouldAutoArchive(base(), now, policy)).toBe(true);
	});

	it('NEVER touches a worktree with an open terminal, however old', () => {
		expect(shouldAutoArchive(base({ hasTerminal: true, lastActivity: now - 400 * DAY }), now, policy)).toBe(false);
	});

	it('spares anything inside the threshold', () => {
		expect(shouldAutoArchive(base({ lastActivity: now - 6 * DAY }), now, policy)).toBe(false);
		expect(shouldAutoArchive(base({ lastActivity: now }), now, policy)).toBe(false);
	});

	it('archives exactly at the boundary', () => {
		expect(shouldAutoArchive(base({ lastActivity: now - 7 * DAY }), now, policy)).toBe(true);
	});

	it('does nothing when the policy is off', () => {
		expect(shouldAutoArchive(base(), now, { enabled: false, maxAgeDays: 7 })).toBe(false);
	});

	it('spares a worktree whose age could not be determined', () => {
		expect(shouldAutoArchive(base({ lastActivity: 0 }), now, policy)).toBe(false);
		expect(shouldAutoArchive(base({ lastActivity: NaN }), now, policy)).toBe(false);
	});

	it('respects a longer configured threshold', () => {
		expect(shouldAutoArchive(base({ lastActivity: now - 20 * DAY }), now, { enabled: true, maxAgeDays: 30 })).toBe(false);
		expect(shouldAutoArchive(base({ lastActivity: now - 40 * DAY }), now, { enabled: true, maxAgeDays: 30 })).toBe(true);
	});
});

describe('latestActivity', () => {
	const now = 1_800_000_000_000;
	it('takes the newest usable signal and ignores junk', () => {
		expect(latestActivity([now - DAY, now - 5 * DAY], now)).toBe(now - DAY);
		expect(latestActivity([0, NaN, undefined, null, now - DAY], now)).toBe(now - DAY);
		expect(latestActivity([], now)).toBe(0);
	});
	it('clamps a future-dated signal (clock skew) to now', () => {
		expect(latestActivity([now + 99 * DAY], now)).toBe(now);
	});
});

describe('archive naming', () => {
	it('stamps a sortable local timestamp', () => {
		expect(timeStamp(new Date(2026, 6, 30, 1, 15, 42))).toBe('20260730-011542');
		expect(timeStamp(new Date(2026, 0, 5, 0, 0, 0))).toBe('20260105-000000');
	});

	it('builds a distinct base name per repo/branch/moment', () => {
		const when = new Date(2026, 6, 30, 1, 15, 42);
		expect(archiveBaseName('My App', 'wt/main-3', when)).toBe('my-app__wt-main-3__20260730-011542');
		// Same branch archived twice is two distinct archives, and they sort chronologically.
		const a = archiveBaseName('r', 'wt/main-1', new Date(2026, 6, 30, 1, 0, 0));
		const b = archiveBaseName('r', 'wt/main-1', new Date(2026, 6, 30, 2, 0, 0));
		expect(a).not.toBe(b);
		expect([b, a].sort()).toEqual([a, b]);
	});

	it('never produces an empty name component', () => {
		expect(archiveBaseName('!!!', '???', new Date(2026, 0, 1))).toBe('repo__branch__20260101-000000');
	});

	it('puts archives outside the repos, under the app profile', () => {
		expect(archiveDirFor('/u/data')).toBe(path.join('/u/data', 'worktree-archives'));
	});
});

describe('humanBytes', () => {
	it('scales sensibly', () => {
		expect(humanBytes(0)).toBe('0 B');
		expect(humanBytes(512)).toBe('512 B');
		expect(humanBytes(2048)).toBe('2.0 KB');
		expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(humanBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
		expect(humanBytes(NaN)).toBe('?');
	});
});

describe('parseManifest', () => {
	const good: Partial<ArchiveManifest> = {
		version: 1, base: 'r__wt-main-1__20260730-011542', repo: 'r', branch: 'wt/main-1',
		worktreePath: '/p/wt-main-1', archivedAtMs: 123, zipBytes: 10, rawBytes: 20, fileCount: 3,
		conversations: [], skippedFiles: [],
	};

	it('parses a well-formed manifest', () => {
		const m = parseManifest(JSON.stringify(good))!;
		expect(m.base).toBe(good.base);
		expect(m.branch).toBe('wt/main-1');
	});

	it('rejects junk rather than yielding a half-built row', () => {
		expect(parseManifest('not json')).toBeNull();
		expect(parseManifest('null')).toBeNull();
		expect(parseManifest('{}')).toBeNull();          // no base
		expect(parseManifest('{"base":""}')).toBeNull(); // empty base
	});

	it('repairs missing collections and numbers so the browser can still list it', () => {
		const m = parseManifest('{"base":"b"}')!;
		expect(m.conversations).toEqual([]);
		expect(m.skippedFiles).toEqual([]);
		expect(m.zipBytes).toBe(0);
		expect(m.archivedAtMs).toBe(0);
	});
});

describe('safeJoin', () => {
	it('keeps extraction inside the target root', () => {
		const root = path.resolve('/tmp/root');
		expect(safeJoin(root, 'a/b.txt')).toBe(path.join(root, 'a/b.txt'));
		expect(safeJoin(root, '../escape.txt')).toBeNull();
		expect(safeJoin(root, '../root-sibling/x')).toBeNull();
		expect(safeJoin(root, 'a/../../../etc/passwd')).toBeNull();
	});
});
