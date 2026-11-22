// V2 Team Floor step 11 — project metrics (design §4 and §D). Pure: no fs, no git, no clock.
//
// ONE TYPE, BOTH CALLERS (FR-30, D11). `wcc-team metrics --json` gathers the facts in a child
// process — git never runs in the renderer's process — and calls buildProjectReport; the Project
// panel renders that JSON and re-runs only the cheap, file-backed sections (open work, tasks) with
// the same functions here. Neither caller is a second implementation of the other.
//
// THE RULE THIS MODULE EXISTS FOR (D12, FR-27): a metric that cannot be computed is
// `value: null` with `unavailable: <reason>`. Never 0 standing in for "unknown", because a zero
// reads as "measured, and the answer is none". A 0 here is always a measured zero. And no metric is
// ever left out: the nine are always nine, so a reader can see that a measurement was expected.

import type { Workstream } from '../../pty-sidecar/workstreams-core.cjs';
import type { SpawnProposal } from '../../pty-sidecar/proposals-core.cjs';
import type { IsolationRecord } from './isolation';
import { attentionIntervals, blockedMs, blockedNow, type AttentionLine } from './attention-log';

export type Freshness = 'live' | '≤30s' | '≤5m' | 'on-demand';

export interface Metric {
	id: string;
	label: string;
	/** null ⇔ unavailable — NEVER 0 standing in for "unknown". */
	value: number | string | null;
	unit?: string;
	/** Literal: the command or file that produced it, so a doubter can run it. */
	source: string;
	/** When the inputs were read (epoch ms), or null when there were none. */
	asOf: number | null;
	freshness: Freshness;
	/** The reason, rendered verbatim in place of the value. Set exactly when value is null. */
	unavailable?: string;
}

export const DAY = 86_400_000;
/** Lead time, rework and isolation cost look back this far (design §4: "last 14 days"). */
export const WINDOW_MS = 14 * DAY;
/** Landed and Updates: the last week. */
export const RECENT_MS = 7 * DAY;
/** Git history is read this far beyond the window, so a branch begun before the window still has
 *  its first commit in view. A branch older than that is reported as a lower bound, by count. */
export const SLACK_MS = 30 * DAY;
export const IDLE_ALIVE_MS = 20 * 60_000;
export const STALE_TASK_MS = 3 * DAY;
/** A floor report older than this is not "the sessions now" — the app is probably not running. */
export const FLOOR_REPORT_MAX_AGE_MS = 15 * 60_000;

/** The nine, in the panel's order. Lead time is the headline. */
export const METRIC_IDS = ['lead-time', 'open-work', 'landed', 'blocked-time', 'rework', 'idle-alive', 'isolation-cost', 'highlights', 'suggestions'] as const;

// ---------------------------------------------------------------------------------------------
// Inputs — gathered by the IO layer (src/cli/team-cli.ts), or the reason they could not be.

/** `ts` is the committer date (when it reached the history it is in); `authorTs` the author date,
 *  which survives a rebase — so a branch's FIRST commit is dated by it, or rebasing a branch before
 *  its merge resets its start to the rebase and lead time reads as minutes. */
export interface GitCommit { sha: string; parents: string[]; ts: number; authorTs: number; subject: string; body: string }
export interface GitTag { name: string; ts: number }
export interface GitFacts {
	repo: string;
	mainline: string;
	tip: string;
	commits: GitCommit[];
	tags: GitTag[];
	/** The literal commands, for the source lines. */
	logCommand: string;
	tagCommand: string;
	readAt: number;
}
export type Sourced<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface VaultLogEntry { date: string; ts: number; file: string; text: string; highlight: boolean }
export interface VaultFacts {
	/** Bullets from Personal/Code/Logs/<date> — <Project>.md files that name this project. */
	logs: VaultLogEntry[];
	logsDir: string;
	/** The `<Project>` part of the log filenames that matched, for a literal source line. */
	logProjects: string[];
	/** Workflow Auditor notes for this project, newest first; null when the folder does not exist. */
	proposals: Array<{ file: string; ts: number; title: string }> | null;
	proposalsDir: string;
	readAt: number;
}

export interface FloorTerminal { name: string; status: 'busy' | 'idle'; idleSince: string | null; dead: boolean; hidden: boolean }
export interface FloorWorktree { repo: string; branch: string; state: string; heldBy: string | null; ahead?: number; dirtyFiles?: number }
export interface FloorFacts { generatedAt: number; terminals: FloorTerminal[]; worktrees: FloorWorktree[] }

export interface ProjectInputs {
	now: number;
	workspace: { id: string; name: string; partition: 'personal' | 'work' };
	/** Which repo stands for this workspace, and how that was decided — shown in the panel. */
	repo: { name: string; path: string; from: 'link' | 'group' | 'name' | 'sessions' } | null;
	git: Sourced<GitFacts>;
	vault: Sourced<VaultFacts>;
	floor: Sourced<FloorFacts>;
	/** The coordination files. Each is a fold of an append-only log; a missing file is []. */
	workstreams: Workstream[];
	workstreamsRead: boolean;
	attention: AttentionLine[];
	isolation: IsolationRecord[];
	proposals: SpawnProposal[];
	/** sessionId → name, from the sessions file and the floor report, for owners. */
	names: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// Outputs.

export interface OpenWorkRow { id: string; title: string; owner: string | null; ownerName: string | null; state: 'todo' | 'doing' | 'blocked' | 'open'; opened: number; ageMs: number; done: number; total: number }
export interface UntrackedRow { branch: string; state: string; heldBy: string | null }
export interface WorkstreamRow {
	id: string; title: string; state: Workstream['state']; ownerName: string | null; ageMs: number; done: number; total: number;
	tasks: Array<{ id: string; title: string; state: string; ownerName: string | null; ageMs: number; stale: boolean; blockedReason?: string }>;
}
export interface UpdateRow { ts: number; kind: 'merge' | 'release' | 'workstream' | 'task' | 'log'; text: string; ref?: string }
export interface ProposalRow { id: string; role: string; task: string; why: string; from: string; to: string | null; toName: string | null; ts: number }

export interface ProjectReport {
	workspaceId: string;
	workspaceName: string;
	partition: 'personal' | 'work';
	repo: ProjectInputs['repo'];
	generatedAt: number;
	/** Always the nine, in METRIC_IDS order. */
	metrics: Metric[];
	/** §D: the measures that never touch git. */
	taskMetrics: Metric[];
	openWork: OpenWorkRow[];
	/** Until a workstream exists: the worktree ledger's dirty / ahead / parked entries (design §4). */
	untracked: UntrackedRow[];
	workstreams: WorkstreamRow[];
	updates: UpdateRow[];
	proposals: ProposalRow[];
}

// ---------------------------------------------------------------------------------------------
// Helpers.

export function median(xs: readonly number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A duration as a number and a unit a person reads: hours under two days, days above. */
export function durationValue(ms: number): { value: number; unit: string } {
	const h = ms / 3_600_000;
	if (h < 48) return { value: Math.round(h * 10) / 10, unit: 'h' };
	return { value: Math.round((h / 24) * 10) / 10, unit: 'd' };
}

const unavailable = (id: string, label: string, source: string, freshness: Freshness, reason: string): Metric =>
	({ id, label, value: null, source, asOf: null, freshness, unavailable: reason });

const nameOf = (names: Readonly<Record<string, string>>, id: string | null): string | null => (id ? names[id] ?? id : null);

// ---------------------------------------------------------------------------------------------
// Git: which commits each first-parent merge landed.

export interface LandedMerge {
	sha: string; ts: number; subject: string; branch: string | null;
	/** The first commit the merge brought in (earliest timestamp), or null for an empty merge. */
	firstTs: number | null;
	commits: number;
	/** True when the walk ran off the edge of the history read, so firstTs is a lower bound. */
	truncated: boolean;
	revertedAt: number | null;
}

/** "Merge wt/main-54: …", "Merge branch 'x'", "Merge pull request #3 from a/b" → the branch name. */
export function mergedBranch(subject: string): string | null {
	const m = /^Merge (?:branch|remote-tracking branch) '([^']+)'/.exec(subject)
		?? /^Merge pull request #\d+ from (\S+)/.exec(subject)
		?? /^Merge ([^\s:]+):/.exec(subject)
		?? /^Merge (\S+)$/.exec(subject);
	return m ? m[1]! : null;
}

/** Walk the first-parent chain from the tip, oldest merge first, and give each merge the commits
 *  only it brought in — merge^1..merge^n, computed in memory from one `git log`. Commits already
 *  claimed (the mainline, or an earlier merge) stop the walk, which is exactly what `..` means. */
export function landedMerges(f: GitFacts): LandedMerge[] {
	const byId = new Map(f.commits.map((c) => [c.sha, c]));
	const chain: GitCommit[] = [];
	for (let c = byId.get(f.tip); c; c = c.parents[0] ? byId.get(c.parents[0]) : undefined) chain.push(c);
	chain.reverse(); // oldest first
	const claimed = new Set(chain.map((c) => c.sha));
	const out: LandedMerge[] = [];
	const mergeOf = new Map<string, LandedMerge>();
	for (const m of chain) {
		if (m.parents.length < 2) continue;
		let firstTs: number | null = null;
		let truncated = false;
		const mine: string[] = [];
		const stack = m.parents.slice(1);
		while (stack.length) {
			const sha = stack.pop()!;
			if (claimed.has(sha)) continue;
			const c = byId.get(sha);
			if (!c) { truncated = true; continue; }
			claimed.add(sha);
			mine.push(sha);
			firstTs = firstTs === null ? c.authorTs : Math.min(firstTs, c.authorTs);
			stack.push(...c.parents);
		}
		const lm: LandedMerge = { sha: m.sha, ts: m.ts, subject: m.subject, branch: mergedBranch(m.subject), firstTs, commits: mine.length, truncated, revertedAt: null };
		for (const sha of mine) mergeOf.set(sha, lm);
		mergeOf.set(m.sha, lm);
		out.push(lm);
	}
	// Reverts: `git revert` writes "This reverts commit <sha>." — of the merge itself (revert -m 1)
	// or of a commit it brought in. Either way that merge was reworked.
	for (const c of f.commits) {
		const r = /This reverts commit ([0-9a-f]{7,40})/.exec(c.body);
		if (!r) continue;
		const target = [...mergeOf.keys()].find((sha) => sha.startsWith(r[1]!));
		const lm = target ? mergeOf.get(target) : undefined;
		if (lm && (lm.revertedAt === null || c.ts < lm.revertedAt)) lm.revertedAt = c.ts;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// The nine.

function leadTime(i: ProjectInputs, merges: LandedMerge[] | null): Metric {
	const id = 'lead-time';
	const since = i.now - WINDOW_MS;
	// Exact, once workstreams have history: open → close(landed).
	const landed = i.workstreams.filter((w) => w.state === 'landed' && w.closed !== undefined && w.closed >= since);
	if (landed.length) {
		const d = durationValue(median(landed.map((w) => w.closed! - w.opened))!);
		return { id, label: `Lead time · median of ${landed.length}, 14 d`, ...d, source: 'workstreams.jsonl · open → close (landed)', asOf: i.now, freshness: 'live' };
	}
	// Proxy until then (D13): a branch's first commit → its merge on the mainline.
	const label = 'Lead time (proxy) · branch first commit → merge, 14 d';
	if (!i.git.ok) return unavailable(id, label, 'git', '≤5m', i.git.reason);
	const g = i.git.value;
	const source = `${g.logCommand} · first-parent merges, merge^1..merge^2`;
	const win = (merges ?? []).filter((m) => m.ts >= since && m.firstTs !== null);
	if (!win.length) return { ...unavailable(id, label, source, '≤5m', `no branch merged into ${g.mainline} in the last 14 days — nothing to measure`), asOf: g.readAt };
	const d = durationValue(median(win.map((m) => m.ts - m.firstTs!))!);
	const cut = win.filter((m) => m.truncated).length;
	return {
		id, label: `Lead time (proxy) · median of ${win.length} merges, 14 d`, ...d,
		source: cut ? `${source} · ${cut} branch${cut === 1 ? '' : 'es'} older than the history read (a lower bound)` : source,
		asOf: g.readAt, freshness: '≤5m',
	};
}

/** Exported: the panel recomputes it live from the file between wcc-team runs. */
export function openWork(i: Pick<ProjectInputs, 'now' | 'workstreams'>): Metric {
	const id = 'open-work';
	const label = 'Open work · workstreams not landed or dropped';
	const source = 'workstreams.jsonl';
	if (!i.workstreams.length) {
		return unavailable(id, label, source, 'live', 'no workstream has been opened in this workspace — `cos-coord workstream open "<title>"`; until then the list shows the worktree ledger\'s untracked work');
	}
	return { id, label, value: i.workstreams.filter((w) => w.state === 'open').length, unit: 'open', source, asOf: i.now, freshness: 'live' };
}

function landed(i: ProjectInputs, merges: LandedMerge[] | null): Metric {
	const id = 'landed';
	const label = 'Landed · last 7 d';
	const since = i.now - RECENT_MS;
	const parts: string[] = [];
	const sources: string[] = [];
	const missing: string[] = [];
	if (i.git.ok) {
		const n = (merges ?? []).filter((m) => m.ts >= since).length;
		parts.push(`${n} merge${n === 1 ? '' : 's'}`);
		sources.push(`${i.git.value.logCommand} (first-parent merges)`);
	} else missing.push(`git: ${i.git.reason}`);
	if (i.workstreams.length) {
		const ws = i.workstreams.filter((w) => w.state === 'landed' && (w.closed ?? 0) >= since).length;
		const tasks = i.workstreams.flatMap((w) => w.tasks).filter((t) => t.state === 'done' && (t.closed ?? 0) >= since).length;
		parts.push(`${ws} workstream${ws === 1 ? '' : 's'}`, `${tasks} task${tasks === 1 ? '' : 's'}`);
		sources.push('workstreams.jsonl');
	} else missing.push('workstreams: none opened yet');
	if (i.vault.ok) {
		const n = i.vault.value.logs.filter((l) => l.ts >= since).length;
		parts.push(`${n} log entr${n === 1 ? 'y' : 'ies'}`);
		const v = i.vault.value;
		sources.push(`${v.logsDir}/<date> — ${v.logProjects.length ? v.logProjects.join(' | ') : i.workspace.name}.md`);
	} else missing.push(`vault: ${i.vault.reason}`);
	if (!parts.length) return unavailable(id, label, 'git · workstreams.jsonl · vault logs', '≤5m', missing.join(' · '));
	return { id, label, value: parts.join(' · '), source: [...sources, ...missing.map((m) => `unavailable — ${m}`)].join(' · '), asOf: i.now, freshness: '≤5m' };
}

function blockedTime(i: ProjectInputs): Metric {
	const id = 'blocked-time';
	const label = 'Blocked time · waiting on you (input + help), 7 d';
	const source = 'attention.jsonl';
	if (!i.attention.length) {
		return unavailable(id, label, source, '≤5m', 'nothing recorded yet — attention.jsonl is written while this workspace is open in the app (since step 11)');
	}
	const { intervals, unknownEnd } = attentionIntervals(i.attention, i.now);
	const ms = blockedMs(intervals, i.now - RECENT_MS, i.now);
	const now = blockedNow(i.attention).length;
	const d = durationValue(ms);
	const first = i.attention[0]!.ts;
	const notes = [
		`${now} blocked now`,
		...(first > i.now - RECENT_MS ? [`recorded since ${new Date(first).toISOString().slice(0, 10)}, not the full 7 d`] : []),
		...(unknownEnd ? [`${unknownEnd} interval${unknownEnd === 1 ? '' : 's'} of unknown length (the app did not shut down cleanly) not counted`] : []),
	];
	return { id, label, ...d, source: `${source} · ${notes.join(' · ')}`, asOf: i.now, freshness: '≤5m' };
}

function rework(i: ProjectInputs, merges: LandedMerge[] | null): Metric {
	const id = 'rework';
	const label = 'Rework rate · landed then reverted or reopened, 14 d';
	const since = i.now - WINDOW_MS;
	let k = 0;
	let n = 0;
	const sources: string[] = [];
	const halves: string[] = [];
	if (i.git.ok) {
		const win = (merges ?? []).filter((m) => m.ts >= since);
		n += win.length;
		k += win.filter((m) => m.revertedAt !== null && m.revertedAt - m.ts <= WINDOW_MS).length;
		sources.push(`${i.git.value.logCommand} · "This reverts commit"`);
	} else halves.push(`revert half unavailable — ${i.git.reason}`);
	// The reopen half: a workstream that landed in the window, or was reopened after landing in it.
	const landedWs = i.workstreams.filter((w) => (w.state === 'landed' && (w.closed ?? 0) >= since) || w.reopens.some((r) => r.from === 'landed' && (r.closed ?? 0) >= since));
	if (landedWs.length) {
		n += landedWs.length;
		k += landedWs.filter((w) => w.reopens.some((r) => r.from === 'landed' && r.ts - (r.closed ?? r.ts) <= WINDOW_MS)).length;
		sources.push('workstreams.jsonl reopen');
	} else halves.push('reopen half unavailable — no workstream has landed in 14 d');
	if (!n) return unavailable(id, label, sources.join(' · ') || 'git · workstreams.jsonl', '≤5m', ['nothing landed in the last 14 days — a rate needs landings to divide by', ...halves].join(' · '));
	return { id, label, value: `${k} / ${n} · ${Math.round((100 * k) / n)}%`, source: [...sources, ...halves].join(' · '), asOf: i.now, freshness: '≤5m' };
}

function idleAlive(i: ProjectInputs): Metric {
	const id = 'idle-alive';
	const label = 'Idle but alive · sessions idle ≥ 20 min';
	const source = 'floor-report.json · session memory idleSince';
	if (!i.floor.ok) return unavailable(id, label, source, '≤5m', i.floor.reason);
	const f = i.floor.value;
	if (i.now - f.generatedAt > FLOOR_REPORT_MAX_AGE_MS) {
		return { ...unavailable(id, label, source, '≤5m', `the floor report is ${Math.round((i.now - f.generatedAt) / 60_000)} min old — is the app running?`), asOf: f.generatedAt };
	}
	const n = f.terminals.filter((t) => !t.dead && t.status === 'idle' && t.idleSince && i.now - Date.parse(t.idleSince) >= IDLE_ALIVE_MS).length;
	return { id, label, value: n, unit: n === 1 ? 'session' : 'sessions', source, asOf: f.generatedAt, freshness: '≤5m' };
}

function isolationCost(i: ProjectInputs): Metric {
	const id = 'isolation-cost';
	const label = 'Isolation cost · worktrees created ÷ workstreams landed, 14 d';
	const source = 'isolation.jsonl ÷ workstreams.jsonl';
	if (!i.isolation.length) return unavailable(id, label, source, '≤5m', 'no spawn decision recorded — isolation.jsonl is written per spawn since step 8, and none has happened in this workspace');
	const since = i.now - WINDOW_MS;
	const created = i.isolation.filter((r) => r.ts >= since && r.ok && r.mode === 'worktree' && r.sessionId && !r.failed).length;
	const landedN = i.workstreams.filter((w) => w.state === 'landed' && (w.closed ?? 0) >= since).length;
	if (!landedN) return { ...unavailable(id, label, source, '≤5m', `no workstream landed in 14 d — the ratio has nothing to divide by (${created} worktree${created === 1 ? '' : 's'} created)`), asOf: i.now };
	return { id, label, value: Math.round((created / landedN) * 100) / 100, unit: `per landing (${created} ÷ ${landedN})`, source, asOf: i.now, freshness: '≤5m' };
}

function highlights(i: ProjectInputs): Metric {
	const id = 'highlights';
	const label = 'Highlights · releases and highlight:: log entries, 14 d';
	const since = i.now - WINDOW_MS;
	const items: string[] = [];
	const sources: string[] = [];
	const missing: string[] = [];
	if (i.git.ok) {
		for (const t of i.git.value.tags.filter((x) => x.ts >= since).sort((a, b) => b.ts - a.ts)) items.push(t.name);
		sources.push(i.git.value.tagCommand);
	} else missing.push(`releases unavailable — ${i.git.reason}`);
	if (i.vault.ok) {
		const h = i.vault.value.logs.filter((l) => l.highlight && l.ts >= since);
		items.push(...h.map((l) => l.text.slice(0, 60)));
		sources.push(`${i.vault.value.logsDir} highlight::`);
	} else missing.push(`highlight:: unavailable — ${i.vault.reason}`);
	if (!sources.length) return unavailable(id, label, 'git tags · vault logs', '≤5m', missing.join(' · '));
	return { id, label, value: items.length ? items.join(', ') : 0, ...(items.length ? {} : { unit: 'in 14 d' }), source: [...sources, ...missing].join(' · '), asOf: i.now, freshness: '≤5m' };
}

function suggestions(i: ProjectInputs): Metric {
	const id = 'suggestions';
	const label = 'Suggestions · newest Workflow Auditor notes';
	if (!i.vault.ok) return unavailable(id, label, 'Personal/Code/Proposals/', 'on-demand', i.vault.reason);
	const v = i.vault.value;
	if (v.proposals === null) return unavailable(id, label, v.proposalsDir, 'on-demand', `the Workflow Auditor is not active yet (ladder step 12) — ${v.proposalsDir} does not exist`);
	const mine = v.proposals;
	return { id, label, value: mine.length ? mine.slice(0, 3).map((p) => p.title).join(' · ') : 0, ...(mine.length ? {} : { unit: 'notes' }), source: `${v.proposalsDir} · project:: ${i.workspace.name}`, asOf: v.readAt, freshness: 'on-demand' };
}

// ---------------------------------------------------------------------------------------------
// §D: the task measures, and the lists.

export function taskMetrics(i: Pick<ProjectInputs, 'now' | 'workstreams'>): Metric[] {
	const source = 'workstreams.jsonl tasks';
	const tasks = i.workstreams.flatMap((w) => w.tasks);
	const none = 'no task has been added in this workspace — `cos-coord workstream task add <ws> "<title>"`';
	if (!tasks.length) {
		return [
			unavailable('progress', 'Progress · tasks done ÷ tasks, open workstreams', source, 'live', none),
			unavailable('task-lead-time', 'Task lead time · median opened → done, 14 d', source, 'live', none),
			unavailable('stale-work', 'Stale work · tasks doing, unchanged ≥ 3 d', source, 'live', none),
		];
	}
	const openTasks = i.workstreams.filter((w) => w.state === 'open').flatMap((w) => w.tasks).filter((t) => t.state !== 'dropped');
	const progress: Metric = openTasks.length
		? { id: 'progress', label: 'Progress · tasks done ÷ tasks, open workstreams', value: `${openTasks.filter((t) => t.state === 'done').length} / ${openTasks.length}`, source, asOf: i.now, freshness: 'live' }
		: unavailable('progress', 'Progress · tasks done ÷ tasks, open workstreams', source, 'live', 'no open workstream has a task');
	const done = tasks.filter((t) => t.state === 'done' && t.closed !== undefined && t.closed >= i.now - WINDOW_MS);
	const lt = median(done.map((t) => t.closed! - t.opened));
	const lead: Metric = lt === null
		? unavailable('task-lead-time', 'Task lead time · median opened → done, 14 d', source, 'live', 'no task was done in the last 14 days')
		: { id: 'task-lead-time', label: `Task lead time · median of ${done.length}, 14 d`, ...durationValue(lt), source, asOf: i.now, freshness: 'live' };
	const stale = tasks.filter((t) => t.state === 'doing' && i.now - t.changed >= STALE_TASK_MS).length;
	return [progress, lead, { id: 'stale-work', label: 'Stale work · tasks doing, unchanged ≥ 3 d', value: stale, unit: stale === 1 ? 'task' : 'tasks', source, asOf: i.now, freshness: 'live' }];
}

export function openWorkRows(i: Pick<ProjectInputs, 'now' | 'workstreams' | 'names'>): OpenWorkRow[] {
	return i.workstreams.filter((w) => w.state === 'open').map((w) => {
		const live = w.tasks.filter((t) => t.state !== 'dropped');
		const state: OpenWorkRow['state'] = live.some((t) => t.state === 'blocked') ? 'blocked' : live.some((t) => t.state === 'doing') ? 'doing' : live.length ? 'todo' : 'open';
		return { id: w.id, title: w.title, owner: w.owner, ownerName: nameOf(i.names, w.owner), state, opened: w.opened, ageMs: i.now - w.opened, done: live.filter((t) => t.state === 'done').length, total: live.length };
	});
}

export function workstreamRows(i: Pick<ProjectInputs, 'now' | 'workstreams' | 'names'>): WorkstreamRow[] {
	// Open first, then the most recently closed — a closed one still shows its tasks' final state.
	const order = [...i.workstreams].sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || (b.closed ?? b.updated) - (a.closed ?? a.updated));
	return order.filter((w) => w.state === 'open' || (w.closed ?? 0) >= i.now - RECENT_MS).map((w) => {
		const live = w.tasks.filter((t) => t.state !== 'dropped');
		return {
			id: w.id, title: w.title, state: w.state, ownerName: nameOf(i.names, w.owner), ageMs: (w.closed ?? i.now) - w.opened,
			done: live.filter((t) => t.state === 'done').length, total: live.length,
			tasks: w.tasks.map((t) => ({
				id: t.id, title: t.title, state: t.state, ownerName: nameOf(i.names, t.owner), ageMs: (t.closed ?? i.now) - t.opened,
				stale: t.state === 'doing' && i.now - t.changed >= STALE_TASK_MS,
				...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
			})),
		};
	});
}

export function proposalRows(proposals: readonly SpawnProposal[], live: ReadonlySet<string> | null): ProposalRow[] {
	return proposals
		.filter((p) => p.state === 'open' && (!live || live.has(p.from.sessionId)))
		.map((p) => ({ id: p.id, role: p.role, task: p.task, why: p.why, from: p.from.name, to: p.to, toName: p.toName ?? p.to, ts: p.ts }));
}

function updates(i: ProjectInputs, merges: LandedMerge[] | null): UpdateRow[] {
	const since = i.now - RECENT_MS;
	const out: UpdateRow[] = [];
	for (const m of merges ?? []) if (m.ts >= since) out.push({ ts: m.ts, kind: 'merge', text: m.branch ? `merged ${m.branch}${m.subject.includes(':') ? ` — ${m.subject.slice(m.subject.indexOf(':') + 1).trim()}` : ''}` : m.subject, ref: m.sha.slice(0, 7) });
	if (i.git.ok) for (const t of i.git.value.tags) if (t.ts >= since) out.push({ ts: t.ts, kind: 'release', text: `released ${t.name}` });
	for (const w of i.workstreams) {
		if (w.opened >= since) out.push({ ts: w.opened, kind: 'workstream', text: `opened ${w.id} — ${w.title}`, ref: w.id });
		if (w.closed !== undefined && w.closed >= since) out.push({ ts: w.closed, kind: 'workstream', text: `${w.state} ${w.id} — ${w.title}`, ref: w.commit ?? w.id });
		for (const r of w.reopens) if (r.ts >= since) out.push({ ts: r.ts, kind: 'workstream', text: `reopened ${w.id}${r.reason ? ` — ${r.reason}` : ''}`, ref: w.id });
		for (const t of w.tasks) if (t.state === 'done' && t.closed !== undefined && t.closed >= since) out.push({ ts: t.closed, kind: 'task', text: `done ${w.id}/${t.id} — ${t.title}`, ref: w.id });
	}
	if (i.vault.ok) for (const l of i.vault.value.logs) if (l.ts >= since) out.push({ ts: l.ts, kind: 'log', text: l.text, ref: l.file });
	return out.sort((a, b) => b.ts - a.ts).slice(0, 25);
}

/** Every section of the panel for one workspace. Pure; the CLI and the panel both call it. */
export function buildProjectReport(i: ProjectInputs): ProjectReport {
	const merges = i.git.ok ? landedMerges(i.git.value) : null;
	const untracked: UntrackedRow[] = !i.workstreams.length && i.floor.ok && i.repo
		? i.floor.value.worktrees.filter((w) => w.repo === i.repo!.name && w.state !== 'clean').map((w) => ({ branch: w.branch, state: w.state, heldBy: w.heldBy }))
		: [];
	return {
		workspaceId: i.workspace.id,
		workspaceName: i.workspace.name,
		partition: i.workspace.partition,
		repo: i.repo,
		generatedAt: i.now,
		metrics: [leadTime(i, merges), openWork(i), landed(i, merges), blockedTime(i), rework(i, merges), idleAlive(i), isolationCost(i), highlights(i), suggestions(i)],
		taskMetrics: taskMetrics(i),
		openWork: openWorkRows(i),
		untracked,
		workstreams: workstreamRows(i),
		updates: updates(i, merges),
		proposals: proposalRows(i.proposals, null),
	};
}

/** The nine's base labels, for when there is no report to read them from yet. */
export const METRIC_LABELS: Record<(typeof METRIC_IDS)[number], string> = {
	'lead-time': 'Lead time · median, 14 d',
	'open-work': 'Open work · workstreams not landed or dropped',
	landed: 'Landed · last 7 d',
	'blocked-time': 'Blocked time · waiting on you (input + help), 7 d',
	rework: 'Rework rate · landed then reverted or reopened, 14 d',
	'idle-alive': 'Idle but alive · sessions idle ≥ 20 min',
	'isolation-cost': 'Isolation cost · worktrees created ÷ workstreams landed, 14 d',
	highlights: 'Highlights · releases and highlight:: log entries, 14 d',
	suggestions: 'Suggestions · newest Workflow Auditor notes',
};

/** All nine, each unavailable for the same reason — while wcc-team runs, or when it failed. The
 *  rows are there either way: a panel that drew nothing until the numbers arrived would hide that
 *  nine measurements were expected. */
export function pendingMetrics(reason: string): Metric[] {
	return METRIC_IDS.map((id) => ({ id, label: METRIC_LABELS[id], value: null, source: 'wcc-team metrics --json', asOf: null, freshness: '≤5m' as const, unavailable: reason }));
}

/** A metric is well-formed: null exactly when there is a reason. The panel checks this before
 *  rendering, and the tests check it for every path — the rule is too easy to break by accident. */
export function metricIsHonest(m: Metric): boolean {
	return m.value === null ? typeof m.unavailable === 'string' && m.unavailable.length > 0 : m.unavailable === undefined;
}
