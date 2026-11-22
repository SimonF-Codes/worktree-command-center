import { describe, it, expect } from 'vitest';
import {
	buildProjectReport, landedMerges, mergedBranch, metricIsHonest, median, durationValue, taskMetrics, METRIC_IDS, DAY,
	type GitCommit, type GitFacts, type ProjectInputs,
} from '../src/core/metrics';
import { foldWorkstreams } from '../pty-sidecar/workstreams-core.cjs';
import type { AttentionLine } from '../src/core/attention-log';
import type { IsolationRecord } from '../src/core/isolation';

const NOW = 100 * DAY;
const H = 3_600_000;

const c = (sha: string, parents: string[], ts: number, subject = sha, body = '', authorTs = ts): GitCommit => ({ sha, parents, ts, authorTs, subject, body });
const facts = (commits: GitCommit[], tip: string, tags: GitFacts['tags'] = []): GitFacts => ({
	repo: 'app', mainline: 'main', tip, commits, tags, logCommand: 'git -C /r log --since=x main', tagCommand: 'git -C /r for-each-ref refs/tags', readAt: NOW,
});

/** Everything unavailable: no repo, no vault, no floor report, no coordination files. */
const bare = (o: Partial<ProjectInputs> = {}): ProjectInputs => ({
	now: NOW,
	workspace: { id: 'w', name: 'Groceries', partition: 'personal' },
	repo: null,
	git: { ok: false, reason: 'no repo' },
	vault: { ok: false, reason: 'vault not configured' },
	floor: { ok: false, reason: 'no floor report yet' },
	workstreams: [], workstreamsRead: false, attention: [], isolation: [], proposals: [], names: {},
	...o,
});

const wsText = (...evs: object[]) => evs.map((e) => JSON.stringify({ v: 1, ...e })).join('\n');

describe('the rule: unavailable is a reason, never a zero, never a missing row', () => {
	it('with nothing to read, all nine are present, in order, and every one carries its reason', () => {
		const r = buildProjectReport(bare());
		expect(r.metrics.map((m) => m.id)).toEqual([...METRIC_IDS]);
		for (const m of [...r.metrics, ...r.taskMetrics]) {
			expect(metricIsHonest(m)).toBe(true);
			expect(m.value, m.id).toBeNull();
			expect(m.unavailable, m.id).toBeTruthy();
			expect(m.source, m.id).toBeTruthy();
		}
		const by = Object.fromEntries(r.metrics.map((m) => [m.id, m.unavailable]));
		expect(by['lead-time']).toBe('no repo');
		expect(by.suggestions).toBe('vault not configured');
		expect(by['idle-alive']).toBe('no floor report yet');
		expect(by['blocked-time']).toMatch(/nothing recorded yet/);
		expect(by['isolation-cost']).toMatch(/no spawn decision recorded/);
	});

	it('the six task measures still work without a repo (design §D)', () => {
		const ws = foldWorkstreams(wsText(
			{ ev: 'open', ts: NOW - 5 * DAY, id: 'ws-1', title: 'Shop' },
			{ ev: 'task', op: 'add', ts: NOW - 5 * DAY, id: 'ws-1', task: 't1', title: 'List' },
			{ ev: 'task', op: 'add', ts: NOW - 5 * DAY, id: 'ws-1', task: 't2', title: 'Buy' },
			{ ev: 'task', op: 'start', ts: NOW - 4 * DAY, id: 'ws-1', task: 't2' },
			{ ev: 'task', op: 'done', ts: NOW - 3 * DAY, id: 'ws-1', task: 't1' },
		));
		const r = buildProjectReport(bare({ workstreams: ws, workstreamsRead: true }));
		const tm = Object.fromEntries(r.taskMetrics.map((m) => [m.id, m]));
		expect(tm.progress!.value).toBe('1 / 2');
		expect(tm['task-lead-time']).toMatchObject({ value: 2, unit: 'd' });
		expect(tm['stale-work']).toMatchObject({ value: 1, unit: 'tasks' }); // doing, unchanged 4 d
		expect(r.metrics.find((m) => m.id === 'open-work')).toMatchObject({ value: 1 });
		expect(r.openWork).toEqual([expect.objectContaining({ id: 'ws-1', state: 'doing', done: 1, total: 2 })]);
		expect(r.metrics.find((m) => m.id === 'landed')!.value).toBe('0 workstreams · 1 task');
	});

	it('a measured zero is a 0, and says what was measured', () => {
		const floor = { ok: true as const, value: { generatedAt: NOW - 60_000, terminals: [{ name: 'a', status: 'busy' as const, idleSince: null, dead: false, hidden: false }], worktrees: [] } };
		const m = buildProjectReport(bare({ floor })).metrics.find((x) => x.id === 'idle-alive')!;
		expect(m).toMatchObject({ value: 0, unit: 'sessions', asOf: NOW - 60_000 });
	});

	it('a stale floor report is a reason, not a count', () => {
		const floor = { ok: true as const, value: { generatedAt: NOW - 3 * H, terminals: [], worktrees: [] } };
		expect(buildProjectReport(bare({ floor })).metrics.find((x) => x.id === 'idle-alive')!.unavailable).toMatch(/180 min old — is the app running/);
	});

	it('metricIsHonest rejects both ways of breaking the rule', () => {
		expect(metricIsHonest({ id: 'x', label: 'x', value: null, source: 's', asOf: null, freshness: 'live' })).toBe(false);
		expect(metricIsHonest({ id: 'x', label: 'x', value: 0, source: 's', asOf: 1, freshness: 'live', unavailable: 'r' })).toBe(false);
	});
});

describe('git: what each first-parent merge landed', () => {
	// main: m0 ── M1 ── m2 ── M2   (tip M2)
	//              \           /
	//   feature-a: a1 ─ a2    /      a1 authored 30 h before M1 but rebased (committed) 1 h before
	//   feature-b:      b1 ──┘       b1 branched from a2 — a2 is already landed, so it is not b's
	const T = NOW - 2 * DAY;
	const commits = [
		c('M2', ['m2', 'b1'], T + 10 * H, 'Merge wt/main-2: second'),
		c('m2', ['M1'], T + 6 * H, 'direct'),
		c('b1', ['a2'], T + 8 * H, 'b work'),
		c('M1', ['m0', 'a2'], T + 5 * H, "Merge branch 'feature-a'"),
		c('a2', ['a1'], T + 4 * H, 'a work 2'),
		c('a1', ['m0'], T + 4 * H, 'a work 1', '', T - 25 * H),
		c('m0', ['old'], T, 'base'), // its parent is outside the history read
	];

	it('gives each merge only the commits it brought in, dated by author', () => {
		const ms = landedMerges(facts(commits, 'M2'));
		expect(ms.map((m) => [m.sha, m.branch, m.commits, m.truncated])).toEqual([['M1', 'feature-a', 2, false], ['M2', 'wt/main-2', 1, false]]);
		expect(ms[0]!.firstTs).toBe(T - 25 * H); // the author date, not the rebase
		expect(ms[1]!.firstTs).toBe(T + 8 * H);
	});

	it('marks a merge whose branch runs off the edge of the history as a lower bound', () => {
		const ms = landedMerges(facts([c('M', ['m', 'x1'], T, 'Merge x'), c('m', [], T - H), c('x1', ['x0'], T - 2 * H)], 'M'));
		expect(ms[0]).toMatchObject({ commits: 1, truncated: true });
	});

	it('a revert of the merge or of a commit in it is rework', () => {
		const withRevert = [c('R', ['M2'], T + 20 * H, 'Revert "a work 2"', 'This reverts commit a2aaaaa.'), ...commits].map((x) => (x.sha === 'a2' ? { ...x, sha: 'a2aaaaaff' } : x.sha === 'M1' ? { ...x, parents: ['m0', 'a2aaaaaff'] } : x));
		const ms = landedMerges(facts(withRevert, 'R'));
		expect(ms.find((m) => m.sha === 'M1')!.revertedAt).toBe(T + 20 * H);
		const r = buildProjectReport(bare({ repo: { name: 'app', path: '/r', from: 'link' }, git: { ok: true, value: facts(withRevert, 'R') } }));
		expect(r.metrics.find((m) => m.id === 'rework')!.value).toBe('1 / 2 · 50%');
		expect(r.metrics.find((m) => m.id === 'rework')!.source).toMatch(/reopen half unavailable — no workstream has landed in 14 d/);
	});

	it('lead time is a labelled proxy from git, the median of the window', () => {
		const r = buildProjectReport(bare({ repo: { name: 'app', path: '/r', from: 'link' }, git: { ok: true, value: facts(commits, 'M2') } }));
		const lt = r.metrics[0]!;
		expect(lt.label).toMatch(/\(proxy\) · median of 2 merges/);
		expect(lt).toMatchObject({ value: 16, unit: 'h' }); // median(30 h, 2 h)
		expect(lt.source).toMatch(/^git -C \/r log --since=x main/);
		expect(r.updates[0]).toMatchObject({ kind: 'merge', text: 'merged wt/main-2 — second', ref: 'M2' });
	});

	it('no merges in the window is a reason, not 0 h', () => {
		const r = buildProjectReport(bare({ repo: { name: 'app', path: '/r', from: 'link' }, git: { ok: true, value: facts([c('m', [], NOW - 40 * DAY)], 'm') } }));
		expect(r.metrics[0]!.unavailable).toMatch(/no branch merged into main in the last 14 days/);
	});

	it('exact lead time once a workstream has landed — open → close', () => {
		const ws = foldWorkstreams(wsText({ ev: 'open', ts: NOW - 3 * DAY, id: 'ws-1', title: 'x' }, { ev: 'close', ts: NOW - DAY, id: 'ws-1', outcome: 'landed' }));
		const lt = buildProjectReport(bare({ workstreams: ws })).metrics[0]!;
		expect(lt).toMatchObject({ label: 'Lead time · median of 1, 14 d', value: 2, unit: 'd', source: 'workstreams.jsonl · open → close (landed)' });
	});

	it('names the branch from the usual merge subjects', () => {
		expect(mergedBranch('Merge wt/main-54: V2 step 10')).toBe('wt/main-54');
		expect(mergedBranch("Merge branch 'feat/x' into main")).toBe('feat/x');
		expect(mergedBranch('Merge pull request #12 from me/fix')).toBe('me/fix');
		expect(mergedBranch('Merge wt/test-timeouts')).toBe('wt/test-timeouts');
		expect(mergedBranch('feat: nothing to see')).toBeNull();
	});
});

describe('the other sources', () => {
	it('blocked time sums input + help over the week, and says how much it saw', () => {
		const attention: AttentionLine[] = [
			{ v: 1, ts: NOW - 2 * H, ev: 'boot' },
			{ v: 1, ts: NOW - 2 * H, sessionId: 's', name: 'S', from: null, to: 'input' },
			{ v: 1, ts: NOW - H, sessionId: 's', name: 'S', from: 'input', to: 'none' },
		];
		const m = buildProjectReport(bare({ attention })).metrics.find((x) => x.id === 'blocked-time')!;
		expect(m).toMatchObject({ value: 1, unit: 'h' });
		expect(m.source).toMatch(/0 blocked now · recorded since/);
	});

	it('isolation cost needs a landing to divide by, and names the numerator while it waits', () => {
		const iso = { v: 1, ts: NOW - DAY, ok: true, mode: 'worktree', sessionId: 's1' } as unknown as IsolationRecord;
		const m = buildProjectReport(bare({ isolation: [iso, { ...iso, sessionId: 's2' }] })).metrics.find((x) => x.id === 'isolation-cost')!;
		expect(m.unavailable).toMatch(/nothing to divide by \(2 worktrees created\)/);
		const ws = foldWorkstreams(wsText({ ev: 'open', ts: NOW - 3 * DAY, id: 'ws-1', title: 'x' }, { ev: 'close', ts: NOW - DAY, id: 'ws-1', outcome: 'landed' }));
		expect(buildProjectReport(bare({ isolation: [iso, { ...iso, sessionId: 's2' }], workstreams: ws })).metrics.find((x) => x.id === 'isolation-cost')).toMatchObject({ value: 2, unit: 'per landing (2 ÷ 1)' });
	});

	it('suggestions: no Proposals folder is the auditor not existing yet, not "no suggestions"', () => {
		const vault = { ok: true as const, value: { logs: [], logsDir: 'Personal/Code/Logs', logProjects: [], proposals: null, proposalsDir: 'Personal/Code/Proposals', readAt: NOW } };
		expect(buildProjectReport(bare({ vault })).metrics.find((x) => x.id === 'suggestions')!.unavailable).toMatch(/not active yet \(ladder step 12\)/);
		const some = { ok: true as const, value: { ...vault.value, proposals: [] } };
		expect(buildProjectReport(bare({ vault: some })).metrics.find((x) => x.id === 'suggestions')).toMatchObject({ value: 0, unit: 'notes' });
	});

	it('untracked work stands in for open work until a workstream exists', () => {
		const floor = { ok: true as const, value: { generatedAt: NOW, terminals: [], worktrees: [
			{ repo: 'app', branch: 'wt/a', state: 'dirty', heldBy: 'wt-a' }, { repo: 'app', branch: 'wt/b', state: 'clean', heldBy: null }, { repo: 'other', branch: 'wt/c', state: 'ahead', heldBy: null },
		] } };
		const r = buildProjectReport(bare({ floor, repo: { name: 'app', path: '/r', from: 'link' } }));
		expect(r.untracked).toEqual([{ branch: 'wt/a', state: 'dirty', heldBy: 'wt-a' }]);
	});

	it('helpers', () => {
		expect(median([])).toBeNull();
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(durationValue(90 * 60_000)).toEqual({ value: 1.5, unit: 'h' });
		expect(durationValue(3 * DAY)).toEqual({ value: 3, unit: 'd' });
		expect(taskMetrics({ now: NOW, workstreams: [] }).every((m) => m.value === null)).toBe(true);
	});
});
