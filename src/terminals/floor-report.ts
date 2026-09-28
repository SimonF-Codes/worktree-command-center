import { computeState, type WorktreeEntry } from './worktree-registry';
import { formatBytes, formatIdle, type MemoryReport, type SessionClaim } from './session-memory';
import { splitMemory } from './memory-gauge';
import { isArchiveSessionsKey } from './closed-workspaces';

/** The floor report: one object answering "what is the state of everything", rendered twice —
 *  `floor-report.json` for tools, `floor-report.md` for a person.
 *
 *  A JOIN, never a scan. Every input here is something the app already gathers for another
 *  reason: the grids' 30s worktree scan, the memory tracker's claims and its last snapshot,
 *  config.json's tabs and targets, the sessions file. Nothing in this module runs a process or
 *  touches the filesystem, so it costs nothing beyond what those already cost — a reporter
 *  that spawned its own `git` per repo would be dearer than most of what it reports on.
 *
 *  Both renderings come from `renderFloorReport(report)`, which serialises ONE object. There is
 *  no second path for either to drift down. */

export const FLOOR_REPORT_SCHEMA = 1;

export type WorktreeState = ReturnType<typeof computeState>;

/** What one grid's scan learned about one repo, beside its worktree entries. */
export interface RepoScan {
	repo: string;
	/** Local branches, from the scan's one `for-each-ref` call. Null when that call failed. */
	branches: number | null;
	/** Newest commit on ANY local branch, primary checkout included. Epoch ms, or null. */
	lastCommitAt: number | null;
}

/** One grid's last scan. Only the MOUNTED grid scans, so other tabs hold what they saw when
 *  they were last in front — which is why every scan carries its own time. */
export interface GridScan {
	workspaceId: string;
	scannedAt: number;
	entries: readonly WorktreeEntry[];
	repos: readonly RepoScan[];
}

export interface FloorTarget {
	name: string;
	path: string;
	folder?: boolean;
	group?: string;
}

export interface FloorInputs {
	now: number;
	workspaces: ReadonlyArray<{ id: string; name: string }>;
	activeWorkspaceId: string;
	targets: readonly FloorTarget[];
	scans: readonly GridScan[];
	claims: readonly SessionClaim[];
	/** The memory tracker's LAST report — never a fresh snapshot taken for this. */
	memory: MemoryReport | null;
	/** `os.totalmem()` / `os.freemem()`, for the same three-way split the gauge shows. */
	machine: { totalBytes: number; freeBytes: number } | null;
	/** `.terminal-sessions.json`: key → saved record count. Null when unreadable. */
	sessionGroups: Readonly<Record<string, number>> | null;
}

export interface ReportTab {
	id: string;
	name: string;
	active: boolean;
	/** Sessions running now, hidden included. A tab not opened this launch has none yet. */
	liveTerminals: number;
	/** Records in the sessions file — what the tab restores when opened. */
	savedSessions: number | null;
	repos: string[];
}

export interface ReportOrphanGroup {
	/** A sessions-file key that no tab and no closed-tab tombstone owns. */
	key: string;
	savedSessions: number;
}

export interface ReportTarget {
	name: string;
	path: string;
	kind: 'git' | 'folder';
	group: string | null;
	/** False for a folder target, or a git target no mounted grid has scanned this launch. */
	scanned: boolean;
	scannedAt: string | null;
	branches: number | null;
	worktrees: number;
	byState: Record<WorktreeState, number>;
	/** Worktrees a live terminal is sitting in. */
	held: number;
	dirtyFiles: number;
	aheadCommits: number;
	lastCommitAt: string | null;
}

export interface ReportWorktree {
	repo: string;
	branch: string;
	path: string;
	state: WorktreeState;
	/** The ref ahead/behind are counted against, or null when the scan did not record one. */
	base: string | null;
	/** Commits on this branch its base lacks, and the reverse. BOTH NULL when the branch was
	 *  compared with itself — a branch outside `wt/<base>-N` that no tile holds has no known base
	 *  — because a 0 there would read as "merged" when it means "not measured". */
	ahead: number | null;
	behind: number | null;
	dirtyFiles: number;
	lastCommitAt: string | null;
	/** The terminal holding it, or null when nothing is. */
	heldBy: string | null;
	scannedAt: string;
}

export interface ReportTerminal {
	name: string;
	tab: string;
	tabId: string;
	repo: string;
	branch: string;
	status: 'busy' | 'idle';
	hidden: boolean;
	idleSince: string | null;
	idleMs: number | null;
	memoryBytes: number | null;
	/** Claimed a pid the last snapshot did not contain: a tile on the floor with no session. */
	dead: boolean;
}

export interface ReportMemory {
	sessionsBytes: number;
	unattributedBytes: number;
	unattributedProcesses: number;
	appSelfBytes: number;
	/** Everything this app holds: sessions + unattributed + itself. A working-set sum. */
	appTotalBytes: number;
	/** The gauge's three quantities — app / other / free — or null when the machine is unknown. */
	machine: { appBytes: number; otherBytes: number; freeBytes: number; totalBytes: number } | null;
}

export interface FloorReport {
	schema: number;
	generatedAt: string;
	tabs: ReportTab[];
	orphanSessionGroups: ReportOrphanGroup[];
	targets: ReportTarget[];
	worktrees: ReportWorktree[];
	terminals: ReportTerminal[];
	totals: {
		tabs: number;
		targets: number;
		worktrees: number;
		worktreesByState: Record<WorktreeState, number>;
		terminals: number;
		busy: number;
		idle: number;
		/** Null until the memory tracker has taken its first snapshot. */
		memory: ReportMemory | null;
	};
}

const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const zeroStates = (): Record<WorktreeState, number> => ({ clean: 0, dirty: 0, ahead: 0, parked: 0 });

/** Join the inputs into one report. Pure. */
export function buildFloorReport(i: FloorInputs): FloorReport {
	// Untagged targets appear in EVERY tab, so several grids may have scanned the same worktree.
	// Keep the newest sighting of each path, and the newest per-repo facts.
	const newestEntry = new Map<string, { e: WorktreeEntry; at: number }>();
	const newestRepo = new Map<string, { r: RepoScan; at: number }>();
	for (const s of i.scans) {
		for (const e of s.entries) {
			const k = norm(e.path);
			const cur = newestEntry.get(k);
			if (!cur || s.scannedAt > cur.at) newestEntry.set(k, { e, at: s.scannedAt });
		}
		for (const r of s.repos) {
			const cur = newestRepo.get(r.repo);
			if (!cur || s.scannedAt > cur.at) newestRepo.set(r.repo, { r, at: s.scannedAt });
		}
	}

	const tabName = new Map(i.workspaces.map((w) => [w.id, w.name]));
	const rowByKey = new Map((i.memory?.sessions ?? []).map((r) => [r.key, r]));
	const userClaims = i.claims.filter((c) => !c.system);

	// Held-by comes from the claims, not the entry's own `terminal`: that one only knows the
	// tiles of the grid that scanned it, and a shared target's worktree can be held from another
	// tab. Claims cover every tab.
	const holder = (e: WorktreeEntry): string | null =>
		userClaims.find((c) => c.repo === e.repo && c.branch === e.branch)?.name ?? e.terminal ?? null;

	const worktrees: ReportWorktree[] = [...newestEntry.values()]
		.map(({ e, at }) => {
			const measured = e.base !== undefined && e.base !== e.branch;
			return {
				repo: e.repo,
				branch: e.branch,
				path: e.path,
				state: computeState(e),
				base: e.base ?? null,
				ahead: measured ? e.ahead : null,
				behind: measured ? e.behind : null,
				dirtyFiles: e.dirtyFiles.length,
				lastCommitAt: iso(e.lastCommitAt),
				heldBy: holder(e),
				scannedAt: iso(at)!,
			};
		})
		.sort((a, b) => a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch, undefined, { numeric: true }));

	const targets: ReportTarget[] = i.targets.map((t) => {
		const wts = worktrees.filter((w) => w.repo === t.name);
		const byState = zeroStates();
		for (const w of wts) byState[w.state]++;
		const rs = newestRepo.get(t.name);
		// A target counts as scanned only when some grid actually listed it this launch.
		const scanned = !t.folder && rs !== undefined;
		return {
			name: t.name,
			path: t.path,
			kind: t.folder ? 'folder' : 'git',
			group: t.group ?? null,
			scanned,
			scannedAt: scanned ? iso(rs!.at) : null,
			branches: rs?.r.branches ?? null,
			worktrees: wts.length,
			byState,
			held: wts.filter((w) => w.heldBy !== null).length,
			dirtyFiles: wts.reduce((a, w) => a + w.dirtyFiles, 0),
			aheadCommits: wts.reduce((a, w) => a + (w.ahead ?? 0), 0),
			lastCommitAt: iso(rs?.r.lastCommitAt ?? null),
		};
	});

	const terminals: ReportTerminal[] = userClaims
		.map((c) => {
			const row = rowByKey.get(c.key);
			const idleMs = !c.busy && c.idleSince !== null ? Math.max(0, i.now - c.idleSince) : null;
			return {
				name: c.name,
				tab: c.workspaceName,
				tabId: c.workspaceId,
				repo: c.repo,
				branch: c.branch,
				status: c.busy ? 'busy' : 'idle',
				hidden: c.hidden,
				idleSince: c.busy ? null : iso(c.idleSince),
				idleMs,
				memoryBytes: row ? row.rssBytes : null,
				dead: row?.dead ?? false,
			} satisfies ReportTerminal;
		})
		.sort((a, b) => a.tab.localeCompare(b.tab) || a.name.localeCompare(b.name));

	const tabs: ReportTab[] = i.workspaces.map((w) => {
		const mine = terminals.filter((t) => t.tabId === w.id);
		return {
			id: w.id,
			name: w.name,
			active: w.id === i.activeWorkspaceId,
			liveTerminals: mine.length,
			savedSessions: i.sessionGroups ? (i.sessionGroups[w.id] ?? 0) : null,
			repos: [...new Set(mine.map((t) => t.repo))].sort(),
		};
	});

	const orphanSessionGroups: ReportOrphanGroup[] = Object.entries(i.sessionGroups ?? {})
		.filter(([k]) => !tabName.has(k) && !isArchiveSessionsKey(k))
		.map(([key, savedSessions]) => ({ key, savedSessions }))
		.sort((a, b) => a.key.localeCompare(b.key));

	const worktreesByState = zeroStates();
	for (const w of worktrees) worktreesByState[w.state]++;

	let memory: ReportMemory | null = null;
	if (i.memory) {
		const m = i.memory;
		const split = i.machine ? splitMemory(i.machine.totalBytes, i.machine.freeBytes, m.totalBytes) : null;
		memory = {
			sessionsBytes: m.sessions.reduce((a, s) => a + s.rssBytes, 0),
			unattributedBytes: m.unattributed.rssBytes,
			unattributedProcesses: m.unattributed.procCount,
			appSelfBytes: m.appSelfBytes,
			appTotalBytes: m.totalBytes,
			machine: split && split.totalBytes > 0 && split.freeKnown
				? { appBytes: split.appBytes, otherBytes: split.otherBytes, freeBytes: split.freeBytes, totalBytes: split.totalBytes }
				: null,
		};
	}

	return {
		schema: FLOOR_REPORT_SCHEMA,
		generatedAt: iso(i.now)!,
		tabs,
		orphanSessionGroups,
		targets,
		worktrees,
		terminals,
		totals: {
			tabs: tabs.length,
			targets: targets.length,
			worktrees: worktrees.length,
			worktreesByState,
			terminals: terminals.length,
			busy: terminals.filter((t) => t.status === 'busy').length,
			idle: terminals.filter((t) => t.status === 'idle').length,
			memory,
		},
	};
}

/** Both renderings of one report. The ONLY way either file's content is produced. */
export function renderFloorReport(report: FloorReport): { json: string; markdown: string } {
	return { json: JSON.stringify(report, null, 2) + '\n', markdown: floorReportMarkdown(report) };
}

const day = (s: string | null): string => (s ? s.slice(0, 10) : '—');
const bytes = (n: number | null): string => (n === null ? '—' : formatBytes(n));
const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** Age of an ISO timestamp against the report's own clock, coarse: "3d 4h ago", "just now". */
function ago(s: string | null, generatedAt: string): string {
	if (!s) return '—';
	const d = formatIdle(Date.parse(generatedAt) - Date.parse(s));
	return d === 'just now' ? d : `${d} ago`;
}

function floorReportMarkdown(r: FloorReport): string {
	const t = r.totals;
	const L: string[] = [];
	L.push('---', 'type: report', `generated: ${r.generatedAt}`, `schema: ${r.schema}`, 'source: Worktree Command Center', '---', '');
	L.push('# Floor Report', '');
	L.push(`_Generated ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC by Worktree Command Center. Overwritten in place; `
		+ 'the same data is in `floor-report.json` beside this note._', '');

	const st = t.worktreesByState;
	L.push('## Summary', '');
	L.push(`- **${t.tabs}** tabs · **${t.targets}** targets · **${t.worktrees}** worktrees `
		+ `(${st.clean} clean, ${st.dirty} dirty, ${st.ahead} ahead, ${st.parked} parked)`);
	L.push(`- **${t.terminals}** terminals live — ${t.busy} busy, ${t.idle} idle`);
	if (t.memory) {
		const m = t.memory;
		const machine = m.machine
			? `${formatBytes(m.machine.appBytes)} this app · ${formatBytes(m.machine.otherBytes)} other · ${formatBytes(m.machine.freeBytes)} free of ${formatBytes(m.machine.totalBytes)}`
			: `${formatBytes(m.appTotalBytes)} this app`;
		L.push(`- Memory: ${machine}`);
		L.push(`  - sessions ${formatBytes(m.sessionsBytes)} · unattributed ${formatBytes(m.unattributedBytes)} `
			+ `(${m.unattributedProcesses} process${m.unattributedProcesses === 1 ? '' : 'es'}) · app itself ${formatBytes(m.appSelfBytes)} `
			+ '— a sum of working sets, so it reads slightly high');
	} else {
		L.push('- Memory: not measured yet this launch');
	}
	const unscanned = r.targets.filter((x) => x.kind === 'git' && !x.scanned).map((x) => x.name);
	if (unscanned.length) L.push(`- Not scanned this launch: ${unscanned.join(', ')}`);
	if (r.orphanSessionGroups.length) {
		L.push(`- Session groups with no tab: ${r.orphanSessionGroups.map((g) => `\`${g.key}\` (${g.savedSessions} saved)`).join(', ')}`);
	}
	L.push('');

	L.push('## Tabs', '');
	L.push('| Tab | Id | Live | Saved | Repos |', '|---|---|--:|--:|---|');
	for (const x of r.tabs) {
		L.push(`| ${cell(x.name)}${x.active ? ' ★' : ''} | \`${x.id}\` | ${x.liveTerminals} | ${x.savedSessions ?? '—'} | ${cell(x.repos.join(', ')) || '—'} |`);
	}
	L.push('', '_★ active tab. Live = sessions running now; a tab not opened this launch shows 0 live and restores its saved ones when opened._', '');

	L.push('## Targets', '');
	L.push('| Target | Branches | Worktrees | Clean | Dirty | Ahead | Parked | Held | Last commit |', '|---|--:|--:|--:|--:|--:|--:|--:|---|');
	for (const x of r.targets) {
		if (x.kind === 'folder') { L.push(`| ${cell(x.name)} (folder) | — | — | — | — | — | — | — | — |`); continue; }
		if (!x.scanned) { L.push(`| ${cell(x.name)} | — | — | — | — | — | — | — | not scanned |`); continue; }
		const b = x.byState;
		L.push(`| ${cell(x.name)} | ${x.branches ?? '—'} | ${x.worktrees} | ${b.clean} | ${b.dirty} | ${b.ahead} | ${b.parked} | ${x.held} | ${day(x.lastCommitAt)} (${ago(x.lastCommitAt, r.generatedAt)}) |`);
	}
	L.push('');

	L.push('## Worktrees', '');
	if (!r.worktrees.length) L.push('_None scanned._');
	for (const repo of [...new Set(r.worktrees.map((w) => w.repo))]) {
		L.push(`### ${repo}`, '');
		L.push('| Branch | State | Base | ↑ | ↓ | Dirty | Last commit | Held by |', '|---|---|---|--:|--:|--:|---|---|');
		for (const w of r.worktrees.filter((x) => x.repo === repo)) {
			const state = w.state === 'clean' ? 'clean' : `**${w.state}**`;
			const base = w.ahead === null || !w.base ? '—' : `\`${cell(w.base)}\``;
			L.push(`| \`${cell(w.branch)}\` | ${state} | ${base} | ${w.ahead ?? '—'} | ${w.behind ?? '—'} | ${w.dirtyFiles} | ${day(w.lastCommitAt)} | ${w.heldBy ? cell(w.heldBy) : '—'} |`);
		}
		L.push('');
	}
	if (r.worktrees.some((w) => w.ahead === null)) {
		L.push('_↑/↓: commits the branch has that its base lacks, and the reverse. "—" means no base was known — a branch '
			+ 'outside `wt/<base>-N` that no terminal holds — so nothing is claimed about whether it is merged._', '');
	}

	L.push('## Terminals', '');
	if (!r.terminals.length) L.push('_None live._', '');
	else {
		L.push('| Terminal | Tab | Repo | Branch | Status | Memory |', '|---|---|---|---|---|--:|');
		for (const x of r.terminals) {
			const status = x.dead ? '**dead**' : x.status === 'busy' ? '**busy**' : `idle ${x.idleMs === null ? '' : formatIdle(x.idleMs)}`.trim();
			L.push(`| ${cell(x.name)}${x.hidden ? ' (hidden)' : ''} | ${cell(x.tab)} | ${cell(x.repo)} | \`${cell(x.branch)}\` | ${status} | ${bytes(x.memoryBytes)} |`);
		}
		L.push('');
	}
	return L.join('\n');
}
