/** Lanes: a progress view in the Project panel (Tree Stage design §7, step P7), pure.
 *
 *  A lane is ONE OPEN WORKSTREAM: how far along it is (done ÷ total), who is on it now (the
 *  sessions whose record carries its `workstreamId`, each with its state dot), how long it has been
 *  open, and how long its sessions have waited on Simon — where the attention log can say.
 *
 *  Three rules this file exists to keep:
 *   - A session with no workstream is NOT a lane. It is counted on one line under the lanes. An
 *     "unassigned" lane is what made lanes fail as a stage layout.
 *   - Token cost has no source. It is a MetricCell with a reason, never a 0 (V2 D12).
 *   - A lane is a read surface. Nothing here moves a session between workstreams.
 *
 *  It reads the ProjectView the panel already builds (its open work: id, title, owner, done, total,
 *  age) plus the floor — the live sessions and attention.jsonl — which the view does not carry. */

import { attentionIntervals, BLOCKED, type AttentionLine } from '../core/attention-log';
import { age, type MetricCell, type ProjectView } from './project-model';
import { dotFor, type DotState } from './sidebar-model';

/** One live session as the grid knows it. `state` is the classifier's (prompt | menu | errored | idle | running). */
export interface LaneSessionInput {
	/** The tile id the panel hands back to reveal it. */
	key: number;
	sessionId: string;
	name: string;
	workstreamId: string | null;
	state: string;
}

/** What the lanes need that the ProjectView does not carry. */
export interface LaneFloor {
	now: number;
	sessions: readonly LaneSessionInput[];
	attention: readonly AttentionLine[];
}

export interface LaneSession { key: number; name: string; dot: DotState }

export interface Lane {
	id: string;
	title: string;
	/** The open-work state: blocked if any task is, else doing, else todo; `open` = no tasks yet. */
	state: 'todo' | 'doing' | 'blocked' | 'open';
	ownerName: string | null;
	done: number;
	total: number;
	/** How long it has been open. */
	age: string;
	sessions: LaneSession[];
	blocked: MetricCell;
}

export interface LanesView {
	lanes: Lane[];
	/** Said in the lanes' place when there are none. Null when there is at least one lane. */
	empty: string | null;
	/** Sessions on this tab outside every open workstream: one line, never a lane. */
	outside: LaneSession[];
	/** Token cost per lane. Always unavailable, with the reason. */
	cost: MetricCell;
}

export const NO_WORKSTREAM_YET = 'No workstream has been opened here, so there are no lanes yet. A lane is one open workstream: '
	+ '`cos-coord workstream open "<title>"` starts one, and a session spawned with `--workstream <id>` serves it.';
export const NONE_OPEN = 'No workstream is open here — every one has landed or been dropped, so there are no lanes.';
export const TOKEN_COST_REASON = 'no source — nothing on the floor records tokens per session, so none can be summed per workstream';

const BLOCKED_SOURCE = 'attention.jsonl · the sessions on it now, since it opened';

function blockedCell(wsId: string, sessionIds: ReadonlySet<string>, since: number, now: number, intervals: ReturnType<typeof attentionIntervals>['intervals']): MetricCell {
	const base = { id: `lane-blocked-${wsId}`, label: 'Blocked · waiting on you', source: BLOCKED_SOURCE, freshness: 'live', asOf: null };
	if (!sessionIds.size) return { ...base, value: null, reason: 'no session is on it now, and blocked time is counted over the sessions serving it' };
	const mine = intervals.filter((i) => sessionIds.has(i.sessionId) && i.end > since && i.start < now);
	if (!mine.length) return { ...base, value: null, reason: 'the attention log has no line for its sessions since it opened' };
	let ms = 0;
	for (const i of mine) if (BLOCKED.has(i.state)) ms += Math.min(i.end, now) - Math.max(i.start, since);
	return { ...base, value: age(ms), reason: null };
}

/** The lanes for one Project view. Pure: the same view and floor always give the same lanes. */
export function lanesOf(view: ProjectView, floor: LaneFloor): LanesView {
	const { now } = floor;
	const open = new Set(view.openWork.map((w) => w.id));
	const toLane = (s: LaneSessionInput): LaneSession => ({ key: s.key, name: s.name, dot: dotFor(s.state) });
	const { intervals } = attentionIntervals(floor.attention, now);

	const lanes: Lane[] = view.openWork.map((w) => {
		const on = floor.sessions.filter((s) => s.workstreamId === w.id);
		return {
			id: w.id, title: w.title, state: w.state, ownerName: w.ownerName, done: w.done, total: w.total, age: w.age,
			sessions: on.map(toLane),
			blocked: blockedCell(w.id, new Set(on.map((s) => s.sessionId)), w.opened, now, intervals),
		};
	});
	return {
		lanes,
		empty: lanes.length ? null : view.untracked ? NO_WORKSTREAM_YET : NONE_OPEN,
		outside: floor.sessions.filter((s) => !s.workstreamId || !open.has(s.workstreamId)).map(toLane),
		cost: {
			id: 'lane-token-cost', label: 'Token cost · per lane', value: null, reason: TOKEN_COST_REASON,
			source: 'none', freshness: 'never', asOf: null,
		},
	};
}
