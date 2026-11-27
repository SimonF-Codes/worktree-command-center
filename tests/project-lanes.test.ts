import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { lanesOf, NO_WORKSTREAM_YET, NONE_OPEN, TOKEN_COST_REASON, type LaneFloor, type LaneSessionInput } from '../src/ui/project-lanes';
import { buildProjectView } from '../src/ui/project-model';
import { parseProjectLanesEnabled } from '../src/core/project-panel';
import { foldWorkstreams } from '../pty-sidecar/workstreams-core.cjs';
import type { AttentionLine, AttentionLogState } from '../src/core/attention-log';
import { renderPanel, serialize, type FakeEl } from './project-panel-render';
import { busyScene, emptyScene, NOW, WORKSTREAMS_JSONL } from './project-panel-scenes';

const M = 60_000;
const H = 60 * M;

const sess = (key: number, sessionId: string, name: string, workstreamId: string | null, state = 'running'): LaneSessionInput => ({ key, sessionId, name, workstreamId, state });
const floor = (sessions: LaneSessionInput[] = [], attention: AttentionLine[] = []): LaneFloor => ({ now: NOW, sessions, attention });
const at = (ts: number, sessionId: string, to: AttentionLogState): AttentionLine => ({ v: 1, ts, sessionId, name: sessionId, from: null, to });

const lanesSection = (host: FakeEl) => host.find((e) => e.has('wcc-proj-section') && e.children[0]?.textContent.startsWith('Lanes'));

// ---------------------------------------------------------------------------------------------
// The empty state FIRST: the default workspace has no workstreams.jsonl, so this is what is seen.

describe('lanes, empty — the default workspace has no workstreams.jsonl', () => {
	it('lanesOf says why there are no lanes, and never makes a lane of the sessions it has', () => {
		const v = buildProjectView(emptyScene());
		const l = lanesOf(v, floor([sess(1, 's-a', 'alice', null), sess(2, 's-b', 'bob', null, 'prompt')]));
		expect(l.lanes).toEqual([]);
		expect(l.empty).toBe(NO_WORKSTREAM_YET);
		expect(l.outside.map((s) => [s.name, s.dot])).toEqual([['alice', 'running'], ['bob', 'needs']]);
		expect(l.cost).toMatchObject({ value: null, reason: TOKEN_COST_REASON });
	});

	it('the panel draws the reason, the outside line and the untracked fallback — not a blank section', () => {
		const { host } = renderPanel(emptyScene(), { lanes: () => floor([sess(1, 's-a', 'alice', null), sess(2, 's-b', 'bob', null)]) });
		const s = lanesSection(host)!;
		expect(s).toBeDefined();
		expect(s.children[0]!.textContent).toBe('Lanes · 0');
		expect(s.find((e) => e.has('wcc-proj-lanes-empty'))!.textContent).toBe(NO_WORKSTREAM_YET);
		expect(s.find((e) => e.has('wcc-proj-lane'))).toBeUndefined(); // no lane at all — least of all an "unassigned" one
		expect(s.find((e) => e.has('wcc-proj-lanes-outside'))!.textContent).toBe('▸ 2 sessions outside any open workstream');
		expect(s.find((e) => e.attrs.get('data-metric') === 'lane-token-cost')!.text()).toContain(`unavailable · ${TOKEN_COST_REASON}`);
		// The untracked fallback the panel already had still follows.
		expect(host.text()).toContain('Untracked work · 0');
		expect(host.find((e) => e.has('wcc-proj-h') && e.textContent.startsWith('Open work'))).toBeUndefined();
	});

	it('with no sessions either, there is no outside line — and still no blank section', () => {
		const { host } = renderPanel(emptyScene(), { lanes: () => floor() });
		const s = lanesSection(host)!;
		expect(s.text()).toContain(NO_WORKSTREAM_YET);
		expect(s.find((e) => e.has('wcc-proj-lanes-outside'))).toBeUndefined();
	});

	it('the outside line selects its sessions: it expands into them, and each brings its tile up', () => {
		const revealed: number[] = [];
		const { host } = renderPanel(emptyScene(), { lanes: () => floor([sess(7, 's-a', 'alice', null)]), onReveal: (k) => revealed.push(k) });
		lanesSection(host)!.find((e) => e.has('wcc-proj-lanes-outside'))!.click();
		const s = lanesSection(host)!;
		expect(s.find((e) => e.has('wcc-proj-lanes-outside'))!.textContent).toBe('▾ 1 session outside any open workstream');
		s.find((e) => e.has('wcc-proj-lane-session'))!.click();
		expect(revealed).toEqual([7]);
	});

	it('workstreams that have all landed or been dropped: says so, and the fallback is not shown', () => {
		const ws = foldWorkstreams([
			JSON.stringify({ v: 1, ev: 'open', ts: NOW - 5 * H, id: 'ws-1', title: 'Done thing' }),
			JSON.stringify({ v: 1, ev: 'close', ts: NOW - H, id: 'ws-1', outcome: 'landed' }),
		].join('\n'));
		const scene = emptyScene({ live: { ...emptyScene().live, workstreams: ws } });
		expect(lanesOf(buildProjectView(scene), floor()).empty).toBe(NONE_OPEN);
		const { host } = renderPanel(scene, { lanes: () => floor() });
		expect(lanesSection(host)!.text()).toContain(NONE_OPEN);
		expect(host.text()).not.toContain('Untracked work');
	});
});

// ---------------------------------------------------------------------------------------------
// Off: the panel exactly as it was before lanes existed.

describe('v2.projectLanes off — the panel byte for byte as it was', () => {
	// git may check the fixture out with CRLF (core.autocrlf): compare the drawing, not the line endings.
	const golden = fs.readFileSync('tests/fixtures/project-panel-today.golden.txt', 'utf8').replace(/\r\n/g, '\n');
	const draw = (lanes?: () => LaneFloor | null) => [emptyScene(), busyScene()].map((s) => serialize(renderPanel(s, lanes ? { lanes } : {}).host)).join('\n=====\n') + '\n';

	it('the golden was recorded from the panel BEFORE lanes were added; off draws it exactly', () => {
		expect(draw()).toBe(golden);
		expect(draw(() => null)).toBe(golden); // the app's off: the dep exists, and answers null
	});

	it('on draws something different — so the off test above is testing something', () => {
		expect(draw(() => floor())).not.toBe(golden);
	});

	it('v2.projectLanes is off unless set to true, and is its own key', () => {
		expect(parseProjectLanesEnabled(undefined)).toBe(false);
		expect(parseProjectLanesEnabled({ projectLanes: 'yes' })).toBe(false);
		expect(parseProjectLanesEnabled({ projectPanel: true })).toBe(false);
		expect(parseProjectLanesEnabled({ projectLanes: true })).toBe(true);
	});

	it('the setting applies live: the same open panel draws lanes on the next refresh after it turns on, and stops after it turns off', () => {
		let on = false;
		const { host, panel } = renderPanel(busyScene(), { lanes: () => (on ? floor() : null) });
		expect(lanesSection(host)).toBeUndefined();
		on = true; panel.refresh();
		expect(lanesSection(host)).toBeDefined();
		on = false; panel.refresh();
		expect(lanesSection(host)).toBeUndefined();
		expect(host.text()).toContain('Open work · 2');
	});
});

// ---------------------------------------------------------------------------------------------
// With workstreams.

describe('lanes — one per open workstream', () => {
	const view = () => buildProjectView(busyScene());

	it('a lane per OPEN workstream only, with progress, owner and age; a landed one is not a lane', () => {
		const l = lanesOf(view(), floor());
		expect(l.empty).toBeNull();
		expect(l.lanes.map((x) => [x.id, x.state, `${x.done}/${x.total}`, x.age, x.ownerName])).toEqual([
			['ws-1', 'blocked', '1/3', '30h', null],
			['ws-2', 'open', '0/0', '5h', null],
		]);
	});

	it('the sessions on it now come from workstreamId, with their state dots; the rest are the outside line', () => {
		const l = lanesOf(view(), floor([
			sess(1, 's-a', 'alice', 'ws-1', 'prompt'),
			sess(2, 's-b', 'bob', 'ws-1', 'idle'),
			sess(3, 's-c', 'carol', 'ws-2', 'errored'),
			sess(4, 's-d', 'dave', null),
			sess(5, 's-e', 'erin', 'ws-3'), // its workstream has landed: outside, not a lane of its own
		]));
		expect(l.lanes.map((x) => x.sessions.map((s) => `${s.name}:${s.dot}`))).toEqual([['alice:needs', 'bob:idle'], ['carol:refused']]);
		expect(l.outside.map((s) => s.name)).toEqual(['dave', 'erin']);
	});

	it('the panel draws each lane with its bar, its sessions and its blocked cell; a click brings a tile up', () => {
		const revealed: number[] = [];
		const { host } = renderPanel(busyScene(), { lanes: () => floor([sess(9, 's-a', 'alice', 'ws-1')]), onReveal: (k) => revealed.push(k) });
		const ws1 = host.find((e) => e.attrs.get('data-lane') === 'ws-1')!;
		expect(ws1.text()).toContain('Checkout flow');
		expect(ws1.find((e) => e.has('wcc-proj-bar-fill'))!.style.width).toBe('33%');
		ws1.find((e) => e.has('wcc-proj-lane-session'))!.click();
		expect(revealed).toEqual([9]);
		expect(host.find((e) => e.attrs.get('data-lane') === 'ws-2')!.text()).toContain('No session on it now.');
		expect(host.find((e) => e.attrs.get('data-lane') === 'ws-3')).toBeUndefined();
		expect(host.find((e) => e.has('wcc-proj-h') && e.textContent.startsWith('Open work'))).toBeUndefined(); // lanes take its place
	});
});

describe('blocked time — from attention.jsonl, never a made-up 0', () => {
	const view = () => buildProjectView(busyScene()); // ws-1 opened 30h ago

	it('sums the input and help intervals of the sessions on it now, clipped to since it opened', () => {
		const att: AttentionLine[] = [
			at(NOW - 40 * H, 's-a', 'input'), // straddles the open: only the part after it counts
			at(NOW - 29 * H, 's-a', 'none'),
			at(NOW - 3 * H, 's-a', 'help'),
			at(NOW - 2 * H, 's-a', 'none'),
			at(NOW - 30 * M, 's-b', 'input'), // still open: runs to now
			at(NOW - 10 * H, 's-x', 'input'), // not on the lane
		];
		const l = lanesOf(view(), floor([sess(1, 's-a', 'alice', 'ws-1'), sess(2, 's-b', 'bob', 'ws-1')], att));
		// 1h (30h→29h) + 1h (3h→2h) + 30m = 2h30m, which age() rounds to the hour.
		expect(l.lanes[0]!.blocked).toMatchObject({ value: '3h', reason: null, source: expect.stringMatching(/^attention\.jsonl/) });
	});

	it('a session that was logged but never blocked reads 0 — the log vouches for it', () => {
		const l = lanesOf(view(), floor([sess(1, 's-a', 'alice', 'ws-1')], [at(NOW - H, 's-a', 'none')]));
		expect(l.lanes[0]!.blocked).toMatchObject({ value: '0m', reason: null });
	});

	it('with nothing in the log for its sessions, it is unavailable with the reason', () => {
		const l = lanesOf(view(), floor([sess(1, 's-a', 'alice', 'ws-1')], [at(NOW - H, 's-zz', 'input')]));
		expect(l.lanes[0]!.blocked).toMatchObject({ value: null, reason: 'the attention log has no line for its sessions since it opened' });
	});

	it('with no session on it, it is unavailable with the reason', () => {
		expect(lanesOf(view(), floor()).lanes[1]!.blocked).toMatchObject({ value: null, reason: expect.stringMatching(/no session is on it now/) });
	});

	it('the panel renders an unavailable blocked cell as its reason, never as 0', () => {
		const { host } = renderPanel(busyScene(), { lanes: () => floor([sess(1, 's-a', 'alice', 'ws-1')]) });
		const c = host.find((e) => e.attrs.get('data-metric') === 'lane-blocked-ws-1')!;
		expect(c.has('unavailable')).toBe(true);
		expect(c.children[0]!.textContent).toBe('unavailable · the attention log has no line for its sessions since it opened');
	});
});

it('the fixture is the real log format (a guard on the golden itself)', () => {
	expect(foldWorkstreams(WORKSTREAMS_JSONL).map((w) => [w.id, w.state, w.tasks.length])).toEqual([['ws-1', 'open', 3], ['ws-2', 'open', 0], ['ws-3', 'landed', 0]]);
});
