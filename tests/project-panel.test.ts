import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { panelPlacement, parseProjectPanelEnabled, PROJECT_PANEL_W } from '../src/core/project-panel';
import { minTileSize, DEFAULT_CELL_METRICS } from '../src/terminals/bubble-layout';
import { buildProjectView, cell, type ProjectViewInput, type RunState } from '../src/ui/project-model';
import { buildProjectReport, METRIC_IDS, type ProjectInputs } from '../src/core/metrics';
import { foldWorkstreams } from '../pty-sidecar/workstreams-core.cjs';
import { ProjectMetricsRunner } from '../src/terminals/project-metrics';
import { SessionChannel } from '../src/terminals/session-channel';
import { lookupFrom } from '../src/core/delegation';
import type { FloorSession, SpawnPlan } from '../src/core/session-requests';
import type { SpawnProposal } from '../pty-sidecar/proposals-core.cjs';

const NOW = 1_800_000_000_000;

describe('where the panel opens — minTileSize, never a pixel breakpoint', () => {
	const m12 = DEFAULT_CELL_METRICS;
	const m20 = { ...DEFAULT_CELL_METRICS, cw: 12, ch: 26 }; // a bigger font: the same window must stop pinning
	it('pins only while the stage beside it still holds one usable terminal', () => {
		const min12 = minTileSize(m12).w; // 80 × 7 + 10 = 570
		expect(panelPlacement({ stageW: min12 + PROJECT_PANEL_W, pinnedNow: false, panelW: PROJECT_PANEL_W, minTileW: min12 })).toBe('column');
		expect(panelPlacement({ stageW: min12 + PROJECT_PANEL_W - 1, pinnedNow: false, panelW: PROJECT_PANEL_W, minTileW: min12 })).toBe('main-pane');
	});
	it('the same window at a bigger font opens in the main pane instead', () => {
		const stageW = 1300;
		expect(panelPlacement({ stageW, pinnedNow: false, panelW: PROJECT_PANEL_W, minTileW: minTileSize(m12).w })).toBe('column');
		expect(panelPlacement({ stageW, pinnedNow: false, panelW: PROJECT_PANEL_W, minTileW: minTileSize(m20).w })).toBe('main-pane'); // 80 × 12 + 10 = 970
	});
	it('a pinned panel measures the stage it would have unpinned, so it never flips itself off', () => {
		const min = minTileSize(m12).w;
		// pinned: the stage is already narrower by the panel — the decision must not change
		expect(panelPlacement({ stageW: min, pinnedNow: true, panelW: PROJECT_PANEL_W, minTileW: min })).toBe('column');
		expect(panelPlacement({ stageW: min - 1, pinnedNow: true, panelW: PROJECT_PANEL_W, minTileW: min })).toBe('main-pane');
	});
	it('v2.projectPanel is off unless set to true', () => {
		expect(parseProjectPanelEnabled(undefined)).toBe(false);
		expect(parseProjectPanelEnabled({ projectPanel: 'yes' })).toBe(false);
		expect(parseProjectPanelEnabled({ projectPanel: true })).toBe(true);
	});
});

const bareInputs = (o: Partial<ProjectInputs> = {}): ProjectInputs => ({
	now: NOW, workspace: { id: 'w', name: 'W', partition: 'personal' }, repo: null,
	git: { ok: false, reason: 'no repo' }, vault: { ok: false, reason: 'vault not configured' }, floor: { ok: false, reason: 'no floor report yet' },
	workstreams: [], workstreamsRead: false, attention: [], isolation: [], proposals: [], names: {}, ...o,
});
const view = (o: Partial<ProjectViewInput> = {}, live: Partial<ProjectViewInput['live']> = {}) => buildProjectView({
	now: NOW, workspace: { id: 'w', name: 'Groceries' }, run: null, running: false,
	live: { workstreams: [], proposals: [], liveSessionIds: new Set(), names: {}, preview: () => ({ ok: true }), ...live },
	...o,
});

describe('the panel view — nine rows, always', () => {
	it('before any run, while running, and after a failure, all nine rows are drawn with the reason', () => {
		for (const [o, reason] of [
			[{}, /not computed yet/],
			[{ running: true }, /computing — wcc-team is running/],
			[{ run: { report: null, error: 'wcc-team failed (exit 1): boom', finishedAt: NOW, roundTripMs: 5, timing: null } as RunState }, /wcc-team failed \(exit 1\): boom/],
		] as const) {
			const v = view(o);
			const rows = [v.headline, ...v.metrics];
			expect(rows.map((r) => r.id)).toEqual([...METRIC_IDS]);
			for (const r of rows) {
				if (r.id === 'open-work') { expect(r.reason).toMatch(/no workstream has been opened/); continue; } // live: a file read, never pending
				expect(r.value).toBeNull();
				expect(r.reason).toMatch(reason);
			}
		}
	});

	it('a cell renders exactly what it is handed: null stays a reason, 0 stays 0', () => {
		expect(cell({ id: 'x', label: 'L', value: 0, unit: 'sessions', source: 's', asOf: NOW - 120_000, freshness: '≤5m' }, NOW)).toMatchObject({ value: '0 sessions', reason: null, asOf: 'as of 2m ago' });
		expect(cell({ id: 'x', label: 'L', value: null, source: 's', asOf: null, freshness: 'live', unavailable: 'why' }, NOW)).toMatchObject({ value: null, reason: 'why', asOf: null });
	});

	it('open work and tasks are live from the file, not from the last run', () => {
		const report = buildProjectReport(bareInputs());
		const ws = foldWorkstreams([
			{ v: 1, ev: 'open', ts: NOW - 7_200_000, id: 'ws-1', title: 'Pantry', by: 's1' },
			{ v: 1, ev: 'assign', ts: NOW - 7_100_000, id: 'ws-1', to: 's1' },
			{ v: 1, ev: 'task', op: 'add', ts: NOW - 7_000_000, id: 'ws-1', task: 't1', title: 'Count tins' },
			{ v: 1, ev: 'task', op: 'block', ts: NOW - 60_000, id: 'ws-1', task: 't1', reason: 'waiting' },
		].map((e) => JSON.stringify(e)).join('\n'));
		const v = view({ run: { report, error: null, finishedAt: NOW - 60_000, roundTripMs: 400, timing: { wallMs: 300, gitCalls: [1, 2], gitMs: 250 } } }, { workstreams: ws, names: { s1: 'pantry-bot' } });
		expect(v.metrics.find((m) => m.id === 'open-work')).toMatchObject({ value: '1 open' });
		expect(v.openWork).toEqual([expect.objectContaining({ id: 'ws-1', ownerName: 'pantry-bot', state: 'blocked', age: '2h' })]);
		expect(v.untracked).toBeNull();
		expect(v.tasks.find((t) => t.id === 'progress')!.value).toBe('0 / 1');
		expect(v.cost).toBe('wcc-team 300 ms · 2 git calls (250 ms) · round trip 400 ms · 1m ago');
		expect(v.subtitle).toBe('personal · no repo');
	});

	it('proposals: open and live only, with the refusal in place of an enabled Accept', () => {
		const p = (id: string, from: string, to: string | null): SpawnProposal => ({ id, ts: NOW - 300_000, from: { sessionId: from, role: 'worker-terminal', name: from.toUpperCase() }, to, workstreamId: null, role: 'researcher', task: `task ${id}`, why: 'splits', state: 'open' });
		const v = view({}, {
			proposals: [p('p1', 'w1', 'lead'), p('p2', 'gone', 'lead'), p('p3', 'w1', null), { ...p('p4', 'w1', 'lead'), state: 'declined' }],
			liveSessionIds: new Set(['w1', 'lead']), names: { lead: 'Lead' },
			preview: (id) => (id === 'p3' ? { ok: false, reason: 'written while unassigned' } : { ok: true }),
		});
		expect(v.proposals.map((x) => [x.id, x.to, x.acceptable, x.refusal])).toEqual([['p1', 'Lead', true, null], ['p3', 'unassigned', false, 'written while unassigned']]);
		expect(v.proposals[0]).toMatchObject({ why: 'splits', from: 'W1', age: '5m' });
	});
});

describe('ProjectMetricsRunner — the child process', () => {
	const ok = (wsId: string) => JSON.stringify({ schema: 1, generatedAt: NOW, workspaces: [buildProjectReport(bareInputs({ workspace: { id: wsId, name: wsId, partition: 'personal' } }))], timing: { wallMs: 12, processMs: 40, workspaces: 1, repos: 0, gitCalls: [], gitMs: 0 } });
	it('runs wcc-team for one workspace, joins a run in flight, and keeps the result', async () => {
		const calls: string[][] = [];
		let t = 0;
		const r = new ProjectMetricsRunner({
			cliPath: '/s/wcc-team.cjs', userData: '/ud', now: () => (t += 100),
			run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: ok('w'), stderr: 'wcc-team: 1 workspace …', timedOut: false }; },
		});
		const [a, b] = await Promise.all([r.refresh('w'), r.refresh('w')]);
		expect(a).toBe(b);
		expect(calls).toEqual([['node', '/s/wcc-team.cjs', 'metrics', '--json', '--workspace', 'w', '--user-data', '/ud']]);
		expect(a).toMatchObject({ error: null, roundTripMs: 100, timing: { wallMs: 12 } });
		expect(a.report!.metrics).toHaveLength(9);
		expect(r.latest('w')).toBe(a);
		expect(r.running('w')).toBe(false);
	});
	it('a failure is a reason, verbatim — never a half-empty report', async () => {
		const mk = (res: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => new ProjectMetricsRunner({ cliPath: 'x', userData: 'u', run: async () => res });
		expect((await mk({ code: 1, stdout: '', stderr: 'wcc-team: cannot read config.json', timedOut: false }).refresh('w')).error).toBe('wcc-team failed (exit 1): wcc-team: cannot read config.json');
		expect((await mk({ code: null, stdout: '', stderr: '', timedOut: true }).refresh('w')).error).toMatch(/did not finish within 60 s/);
		expect((await mk({ code: 0, stdout: 'not json', stderr: '', timedOut: false }).refresh('w')).error).toMatch(/not its JSON/);
		expect((await mk({ code: 0, stdout: ok('other'), stderr: '', timedOut: false }).refresh('w')).error).toMatch(/no report for "w"/);
	});
});

describe('the UI may not import an IO module — for this step that is the point (D11)', () => {
	const FORBIDDEN = /from '(fs|fs\/promises|child_process|os|node:[a-z_/]+)'|require\('(fs|child_process)'\)|from '\.\.\/terminals\/(?!bubble-layout')/;
	const seen = new Set<string>();
	function walk(file: string): string[] {
		if (seen.has(file)) return [];
		seen.add(file);
		const src = fs.readFileSync(file, 'utf8');
		const bad = src.split('\n').filter((l) => /^import (?!type )/.test(l) && FORBIDDEN.test(l)).map((l) => `${path.relative(process.cwd(), file)}: ${l.trim()}`);
		for (const m of src.matchAll(/^import (?!type )[^;]*from '(\.[^']+)'/gm)) {
			const base = path.resolve(path.dirname(file), m[1]!);
			const next = ['.ts', '.cjs', '/index.ts'].map((e) => base + e).find((p) => fs.existsSync(p));
			if (next && next.endsWith('.ts')) bad.push(...walk(next));
			if (next && next.endsWith('.cjs') && /require\('(fs|child_process)'\)/.test(fs.readFileSync(next, 'utf8'))) bad.push(`${next}: requires fs/child_process`);
		}
		return bad;
	}
	it('project-panel.ts and everything it imports at runtime', () => {
		expect(walk(path.resolve('src/ui/project-panel.ts'))).toEqual([]);
	});
});

describe('Accept / Decline from the panel act FOR the addressee', () => {
	const lookup = lookupFrom([
		{ slug: 'alpha', authority: 'operator', spawns: [] },
		{ slug: 'team-lead', authority: 'operator', spawns: ['worker-terminal'] },
		{ slug: 'worker-terminal', authority: 'operator', spawns: [] },
		{ slug: 'researcher', authority: 'proposer', spawns: [] },
	]);
	const floor: FloorSession[] = [
		{ key: 1, sessionId: 'lead', name: 'Lead', role: 'team-lead' },
		{ key: 2, sessionId: 'w2', name: 'W2', role: 'worker-terminal', parentSessionId: 'lead', repoName: 'app' },
	];
	let dir: string;
	let spawned: SpawnPlan[];
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projpanel-')); spawned = []; });
	const channel = () => new SessionChannel({
		coordDir: dir, enabled: () => true, lookup: () => lookup, floor: () => floor, repos: () => [{ name: 'app' }],
		spawn: async (plan) => { spawned.push(plan); return { ok: true, spawned: { terminal: 'wt-main-9', branch: 'wt/main-9', sessionId: 'child-9' } }; },
		tell: async () => ({ ok: true }), assign: () => true, now: () => NOW,
	});
	const propose = (id: string, role: string, to: string | null) => fs.appendFileSync(path.join(dir, 'spawn-proposals.jsonl'), JSON.stringify({ v: 1, ev: 'propose', ts: NOW - 1000, id, from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' }, to, workstreamId: null, role, task: `task ${id}`, why: 'it splits' }) + '\n');
	const lines = () => fs.readFileSync(path.join(dir, 'spawn-proposals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

	it('accept spawns under the addressee, after the same delegation check, and records that Simon clicked', async () => {
		propose('p1', 'worker-terminal', 'lead');
		const c = channel();
		expect(c.previewAccept('p1')).toEqual({ ok: true });
		const r = await c.decideForAddressee('p1', 'accept');
		expect(r).toMatchObject({ ok: true, message: expect.stringContaining('under Lead') });
		expect(spawned).toMatchObject([{ parentSessionId: 'lead', childRole: 'worker-terminal', repo: 'app' }]);
		expect(lines().at(-1)).toMatchObject({ ev: 'accept', id: 'p1', by: 'simon', byName: 'Simon (for Lead)', spawned: 'child-9' });
		expect(await c.decideForAddressee('p1', 'accept')).toMatchObject({ ok: false, reason: expect.stringContaining('already accepted') });
	});

	it('a role the addressee may not spawn is refused with the identical message — clicking grants nothing', async () => {
		propose('p2', 'researcher', 'lead');
		const c = channel();
		const pre = c.previewAccept('p2');
		const r = await c.decideForAddressee('p2', 'accept');
		expect(r.ok).toBe(false);
		expect(pre).toEqual(r);
		expect(!r.ok && r.reason).toMatch(/condition 1 of 3 \(listed\)/);
		expect(spawned).toEqual([]);
		expect(lines()).toHaveLength(1); // nothing appended: still open
	});

	it('an unassigned proposal cannot be accepted from the panel, but can be declined — with a reason', async () => {
		propose('p3', 'worker-terminal', null);
		const c = channel();
		expect((await c.decideForAddressee('p3', 'accept'))).toMatchObject({ ok: false, reason: expect.stringContaining('cos-coord proposal accept p3') });
		expect((await c.decideForAddressee('p3', 'decline', '  '))).toMatchObject({ ok: false, reason: expect.stringContaining('needs a reason') });
		expect((await c.decideForAddressee('p3', 'decline', 'not now'))).toMatchObject({ ok: true });
		expect(lines().at(-1)).toMatchObject({ ev: 'decline', id: 'p3', by: 'simon', reason: 'not now' });
	});
});

describe('foldCached — re-fold an append-only log only when it changed', () => {
	it('returns the same fold until the file grows, and folds a missing file as empty', async () => {
		const { foldCached } = await import('../src/terminals/append-log-cache');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foldcache-'));
		const f = path.join(dir, 'log.jsonl');
		let folds = 0;
		const fold = (t: string) => { folds++; return t.split('\n').filter(Boolean); };
		expect(foldCached(f, fold)).toEqual([]);
		fs.writeFileSync(f, 'a\n');
		const one = foldCached(f, fold);
		expect(foldCached(f, fold)).toBe(one);
		expect(folds).toBe(2);
		fs.appendFileSync(f, 'b\n');
		expect(foldCached(f, fold)).toEqual(['a', 'b']);
		expect(folds).toBe(3);
	});
});
