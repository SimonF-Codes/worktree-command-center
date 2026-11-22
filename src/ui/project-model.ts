/** The Project panel's view (V2 Team Floor step 11), pure. Every decision the panel draws is made
 *  here and tested here; project-panel.ts only draws it.
 *
 *  Two inputs, one implementation. The metrics come from the last `wcc-team metrics` run (a child
 *  process — git never runs here). The sections that are a plain file read — open work, the tasks,
 *  the proposals — are recomputed live from the same core/metrics.ts functions the CLI used, so
 *  they never wait five minutes for a task you just marked done, and are never a second copy.
 *
 *  THE RULE: a metric with no value renders its reason in place of the value. While wcc-team is
 *  still running, or after it failed, all nine rows are still drawn, each giving that as its reason. */

import {
	openWork, openWorkRows, pendingMetrics, proposalRows, taskMetrics, workstreamRows,
	type Metric, type OpenWorkRow, type ProjectReport, type UntrackedRow, type UpdateRow, type WorkstreamRow,
} from '../core/metrics';
import type { Workstream } from '../../pty-sidecar/workstreams-core.cjs';
import type { SpawnProposal } from '../../pty-sidecar/proposals-core.cjs';

/** What the panel needs of a metrics run — structurally a terminals/project-metrics MetricsRun. */
export interface RunState {
	report: ProjectReport | null;
	error: string | null;
	finishedAt: number | null;
	roundTripMs: number | null;
	timing: { wallMs: number; gitCalls: unknown[]; gitMs: number } | null;
}

export interface ProjectViewInput {
	now: number;
	workspace: { id: string; name: string };
	run: RunState | null;
	running: boolean;
	live: {
		workstreams: Workstream[];
		proposals: SpawnProposal[];
		/** Session ids on the floor right now: a proposal whose proposer is gone reads as stale. */
		liveSessionIds: ReadonlySet<string>;
		names: Readonly<Record<string, string>>;
		/** Would Accept pass right now? (the same evaluation as a real accept, minus the spawn) */
		preview: (proposalId: string) => { ok: true } | { ok: false; reason: string };
	};
}

export interface MetricCell {
	id: string;
	label: string;
	/** The value, formatted; null when unavailable. */
	value: string | null;
	/** The reason, verbatim, when value is null. */
	reason: string | null;
	source: string;
	freshness: string;
	asOf: string | null;
}

export interface ProposalCard {
	id: string; role: string; task: string; why: string; from: string; to: string; age: string;
	acceptable: boolean;
	/** Why Accept is unavailable, when it is. */
	refusal: string | null;
}

export interface ProjectView {
	title: string;
	subtitle: string;
	headline: MetricCell;
	metrics: MetricCell[];
	tasks: MetricCell[];
	openWork: Array<OpenWorkRow & { age: string }>;
	/** Shown in Open work's place until a workstream exists. */
	untracked: UntrackedRow[] | null;
	workstreams: Array<Omit<WorkstreamRow, 'tasks'> & { age: string; tasks: Array<WorkstreamRow['tasks'][number] & { age: string }> }>;
	updates: Array<UpdateRow & { when: string }>;
	proposals: ProposalCard[];
	/** NFR-2, in the panel: what the last refresh cost. */
	cost: string;
	running: boolean;
}

export function age(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function when(ts: number, now: number): string {
	const d = new Date(ts);
	const today = new Date(now);
	const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
	const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** One cell, exactly as handed: a null stays a reason, a 0 stays a 0. */
export function cell(m: Metric, now: number): MetricCell {
	const value = m.value === null ? null : `${typeof m.value === 'number' ? m.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : m.value}${m.unit ? ` ${m.unit}` : ''}`;
	return {
		id: m.id, label: m.label, value,
		reason: m.value === null ? (m.unavailable || 'unavailable — no reason was given, which is itself a bug') : null,
		source: m.source, freshness: m.freshness,
		asOf: m.asOf === null ? null : now - m.asOf < 60_000 ? 'as of just now' : `as of ${age(now - m.asOf)} ago`,
	};
}

export function buildProjectView(i: ProjectViewInput): ProjectView {
	const { now } = i;
	const report = i.run?.report ?? null;
	const pendingReason = i.running && !report
		? 'computing — wcc-team is running'
		: i.run?.error ?? (report ? '' : 'not computed yet — the panel runs wcc-team when it opens');
	const base = report ? report.metrics : pendingMetrics(pendingReason);
	// Open work is a file read: live, whatever the last run said.
	const liveOpen = openWork({ now, workstreams: i.live.workstreams });
	const metrics = base.map((m) => (m.id === 'open-work' ? liveOpen : m)).map((m) => cell(m, now));
	const live = { now, workstreams: i.live.workstreams, names: i.live.names };

	const cost = i.running
		? 'computing — wcc-team is running in a child process'
		: i.run?.timing
			? `wcc-team ${i.run.timing.wallMs} ms · ${i.run.timing.gitCalls.length} git call${i.run.timing.gitCalls.length === 1 ? '' : 's'} (${i.run.timing.gitMs} ms) · round trip ${i.run.roundTripMs} ms · ${age(now - (i.run.finishedAt ?? now))} ago`
			: i.run?.error ? `last run failed — ${i.run.error}` : 'not run yet';

	const repo = report?.repo;
	return {
		title: `Project · ${i.workspace.name}`,
		subtitle: report
			? `${report.partition} · ${repo ? `${repo.name} (${repo.from === 'link' ? 'linked' : repo.from === 'group' ? 'tagged to this tab' : repo.from === 'name' ? 'same name' : 'where its terminals work'})` : 'no repo'}`
			: 'personal',
		headline: metrics[0]!,
		metrics: metrics.slice(1),
		tasks: taskMetrics(live).map((m) => cell(m, now)),
		openWork: openWorkRows(live).map((r) => ({ ...r, age: age(r.ageMs) })),
		untracked: i.live.workstreams.length ? null : (report?.untracked ?? []),
		workstreams: workstreamRows(live).map((w) => ({ ...w, age: age(w.ageMs), tasks: w.tasks.map((t) => ({ ...t, age: age(t.ageMs) })) })),
		updates: (report?.updates ?? []).map((u) => ({ ...u, when: when(u.ts, now) })),
		proposals: proposalRows(i.live.proposals, i.live.liveSessionIds).map((p) => {
			const v = i.live.preview(p.id);
			return {
				id: p.id, role: p.role, task: p.task, why: p.why, from: p.from,
				to: p.to ? (i.live.names[p.to] ?? p.toName ?? p.to) : 'unassigned', age: age(now - p.ts),
				acceptable: v.ok, refusal: v.ok ? null : v.reason,
			};
		}),
		cost,
		running: i.running,
	};
}

/** For re-render de-duplication: the view is already formatted to the minute. */
export function projectViewSignature(v: ProjectView): string { return JSON.stringify(v); }
