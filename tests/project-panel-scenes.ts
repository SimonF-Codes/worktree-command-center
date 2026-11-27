// The Project panel inputs the render tests draw: one with no workstream (the default workspace —
// no workstreams.jsonl), and one with open, blocked and landed work and two proposals.
import { buildProjectReport, type ProjectInputs } from '../src/core/metrics';
import { foldWorkstreams } from '../pty-sidecar/workstreams-core.cjs';
import type { ProjectViewInput } from '../src/ui/project-model';
import type { SpawnProposal } from '../pty-sidecar/proposals-core.cjs';

export const NOW = 1_800_000_000_000;
const H = 3_600_000;

const bareInputs = (o: Partial<ProjectInputs> = {}): ProjectInputs => ({
	now: NOW, workspace: { id: 'w', name: 'W', partition: 'personal' }, repo: null,
	git: { ok: false, reason: 'no repo' }, vault: { ok: false, reason: 'vault not configured' }, floor: { ok: false, reason: 'no floor report yet' },
	workstreams: [], workstreamsRead: false, attention: [], isolation: [], proposals: [], names: {}, ...o,
});

export const WORKSTREAMS_JSONL = [
	{ v: 1, ev: 'open', ts: NOW - 30 * H, id: 'ws-1', title: 'Checkout flow', by: 's-a' },
	{ v: 1, ev: 'task', op: 'add', ts: NOW - 29 * H, id: 'ws-1', task: 't1', title: 'Cart page', owner: 's-a' },
	{ v: 1, ev: 'task', op: 'add', ts: NOW - 29 * H, id: 'ws-1', task: 't2', title: 'Payment form', owner: 's-b' },
	{ v: 1, ev: 'task', op: 'add', ts: NOW - 29 * H, id: 'ws-1', task: 't3', title: 'Receipt email' },
	{ v: 1, ev: 'task', op: 'start', ts: NOW - 20 * H, id: 'ws-1', task: 't1' },
	{ v: 1, ev: 'task', op: 'done', ts: NOW - 10 * H, id: 'ws-1', task: 't1' },
	{ v: 1, ev: 'task', op: 'block', ts: NOW - 2 * H, id: 'ws-1', task: 't2', reason: 'needs the API key' },
	{ v: 1, ev: 'open', ts: NOW - 5 * H, id: 'ws-2', title: 'Search index', by: 's-c' },
	{ v: 1, ev: 'open', ts: NOW - 80 * H, id: 'ws-3', title: 'Old migration', by: 's-a' },
	{ v: 1, ev: 'close', ts: NOW - 4 * H, id: 'ws-3', outcome: 'landed', commit: 'abc1234' },
].map((e) => JSON.stringify(e)).join('\n');

const proposals: SpawnProposal[] = [
	{ id: 'p1', ts: NOW - H, state: 'open', role: 'tester', task: 'Write the receipt tests', why: 'nobody owns t3', from: { sessionId: 's-a', name: 'alice' }, to: 's-c', toName: 'carol' },
	{ id: 'p2', ts: NOW - 2 * H, state: 'open', role: 'writer', task: 'Draft the docs', why: 'release soon', from: { sessionId: 's-b', name: 'bob' }, to: null },
] as unknown as SpawnProposal[];

const names = { 's-a': 'alice', 's-b': 'bob', 's-c': 'carol' };

export function emptyScene(o: Partial<ProjectViewInput> = {}): ProjectViewInput {
	return {
		now: NOW, workspace: { id: 'w', name: 'Groceries' }, run: null, running: false,
		live: { workstreams: [], proposals: [], liveSessionIds: new Set(), names: {}, preview: () => ({ ok: true }) },
		...o,
	};
}

export function busyScene(o: Partial<ProjectViewInput> = {}): ProjectViewInput {
	const workstreams = foldWorkstreams(WORKSTREAMS_JSONL);
	const report = buildProjectReport(bareInputs({ workstreams, workstreamsRead: true, names }));
	return {
		now: NOW, workspace: { id: 'w', name: 'Shop' },
		run: { report, error: null, finishedAt: NOW - 60_000, roundTripMs: 40, timing: { wallMs: 30, gitCalls: [], gitMs: 0 } },
		running: false,
		live: {
			workstreams, proposals, liveSessionIds: new Set(['s-a', 's-b', 's-c']), names,
			preview: (id) => (id === 'p2' ? { ok: false, reason: 'it is addressed to nobody' } : { ok: true }),
		},
		...o,
	};
}
