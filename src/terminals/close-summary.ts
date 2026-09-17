/** Pure logic for the "close this workspace?" confirm — no IO/DOM, so it unit-tests cleanly.
 *
 *  The guard this replaces asked the LIVE grid how many terminals a tab had (`terminalCount()`).
 *  A workspace you have not switched to since launch has its grid CONSTRUCTED but not mounted, so
 *  its tile list is empty no matter how many terminals are saved on disk — the confirm was skipped
 *  entirely for exactly the tab you are most likely to close by accident, and the QMK-Flasher tab
 *  was lost that way. Everything here counts from PERSISTED records; live records are used only
 *  when the caller says the grid has restored its sessions and is therefore authoritative. */

import { CLOSED_WORKSPACES_CAP } from './closed-workspaces';

/** The fields of a persisted session record this module needs. Structural on purpose: the
 *  grid's SessionRecord satisfies it, and so does a live tile's descriptor. */
export interface CloseRecord {
	kind?: 'terminal' | 'journal' | 'god';
	name?: string;
	repoName?: string;
	branch?: string;
	worktreePath?: string;
	baseBranch?: string;
	folder?: boolean;
}

/** Git state of one worktree, probed by the caller (IO) and handed back in. */
export interface WorktreeRisk {
	/** Uncommitted files (`git status --porcelain`). */
	dirtyFiles: number;
	/** Commits on the branch that are not on its base branch. */
	unpushed: number;
	/** The probe failed. Counted as risky, never as clean — an unverified worktree is
	 *  exactly the one you must not silently throw away. */
	unknown?: boolean;
}

export interface CloseItem {
	/** Terminal name. */
	label: string;
	/** "repo / branch", or the folder path for a folder target. */
	detail: string;
	worktreePath: string;
	baseBranch: string;
}

export interface CloseSummary {
	/** Where the numbers came from — 'persisted' whenever the grid could not answer. */
	source: 'live' | 'persisted';
	/** Terminals + journals + consoles. */
	total: number;
	terminals: CloseItem[];
	journals: number;
	consoles: number;
}

/** How many rows the dialog lists before collapsing the rest into "+N more". */
export const MAX_LISTED = 6;

/** Which record set the confirm should count. `live` is null unless the grid has actually
 *  restored its sessions — THE fix: an unrestored grid never gets to claim the tab is empty. */
export function pickCloseRecords(
	live: CloseRecord[] | null,
	persisted: CloseRecord[],
): { records: CloseRecord[]; source: 'live' | 'persisted' } {
	return live ? { records: live, source: 'live' } : { records: persisted, source: 'persisted' };
}

function itemFor(r: CloseRecord): CloseItem {
	const branch = r.branch ?? '';
	const repo = r.repoName ?? '';
	const detail = r.folder
		? (r.worktreePath || repo || 'folder')
		: [repo, branch].filter(Boolean).join(' / ') || (r.worktreePath ?? '');
	return {
		label: r.name || branch || r.worktreePath || 'terminal',
		detail,
		worktreePath: r.worktreePath ?? '',
		baseBranch: r.baseBranch ?? '',
	};
}

export function summarizeClose(records: CloseRecord[], source: 'live' | 'persisted'): CloseSummary {
	const terminals: CloseItem[] = [];
	let journals = 0;
	let consoles = 0;
	for (const r of records ?? []) {
		if (!r) continue;
		if (r.kind === 'god') consoles++;
		else if (r.kind === 'journal') journals++;
		else terminals.push(itemFor(r));
	}
	return { source, total: terminals.length + journals + consoles, terminals, journals, consoles };
}

/** Worktrees worth a `git status` before the dialog opens: real repos only (a folder target
 *  has no branch of its own), deduped by path. */
export function riskProbeTargets(summary: CloseSummary): { worktreePath: string; baseBranch: string }[] {
	const seen = new Set<string>();
	const out: { worktreePath: string; baseBranch: string }[] = [];
	for (const t of summary.terminals) {
		if (!t.worktreePath || !t.baseBranch || seen.has(t.worktreePath)) continue;
		seen.add(t.worktreePath);
		out.push({ worktreePath: t.worktreePath, baseBranch: t.baseBranch });
	}
	return out;
}

function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

/** "3 terminals, 1 journal and Kane's console" — what the tab actually holds. */
function describeContents(s: CloseSummary): string {
	const parts: string[] = [];
	if (s.terminals.length) parts.push(plural(s.terminals.length, 'terminal'));
	if (s.journals) parts.push(plural(s.journals, 'journal'));
	if (s.consoles) parts.push(s.consoles === 1 ? 'a workspace console' : `${s.consoles} workspace consoles`);
	if (parts.length <= 1) return parts[0] ?? '';
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function listLines(items: { label: string; detail: string }[]): string[] {
	const shown = items.slice(0, MAX_LISTED);
	const lines = shown.map((i) => `  • ${i.label}${i.detail ? ` — ${i.detail}` : ''}`);
	if (items.length > shown.length) lines.push(`  • +${items.length - shown.length} more`);
	return lines;
}

/** Why one worktree's loss is not recoverable from git, or '' when it is clean. */
export function riskReason(risk: WorktreeRisk | undefined): string {
	if (!risk) return '';
	if (risk.unknown) return 'could not be checked';
	const bits: string[] = [];
	if (risk.dirtyFiles > 0) bits.push(plural(risk.dirtyFiles, 'uncommitted file'));
	if (risk.unpushed > 0) bits.push(plural(risk.unpushed, 'unmerged commit'));
	return bits.join(', ');
}

/** The line both bodies end on. Closing is recoverable now (closed-workspaces.ts) and saying so
 *  is part of being honest — but it is a bounded archive, not an undo stack, so it says how
 *  bounded rather than implying the close can always be taken back. */
function reopenNote(): string {
	return `Recently closed keeps the last ${CLOSED_WORKSPACES_CAP}, so the tab can be reopened.`;
}

/** The confirm body. Always says something — an empty tab gets one line, a tab with dirty
 *  worktrees gets the warning — because "looks empty, skip the dialog" is the bug itself. */
export function closeConfirmMessage(
	name: string,
	summary: CloseSummary,
	risks: Record<string, WorktreeRisk> = {},
): string {
	if (summary.total === 0) {
		return `"${name}" has no saved terminals. Closing removes the tab. ${reopenNote()}`;
	}

	const out: string[] = [];
	out.push(`"${name}" has ${describeContents(summary)} saved:`);
	out.push('');
	out.push(...listLines(summary.terminals));

	const risky = summary.terminals
		.map((t) => ({ item: t, reason: riskReason(risks[t.worktreePath]) }))
		.filter((r) => r.reason);
	if (risky.length) {
		out.push('');
		// The sentence meant to stop a click: uncommitted files and unmerged commits are the only
		// things here that no git command would hand back once you stop pointing at the worktree.
		out.push(`⚠ ${plural(risky.length, 'worktree holds', 'worktrees hold')} work git could not give back:`);
		out.push(...listLines(risky.map((r) => ({ label: r.item.label, detail: r.reason }))));
	} else if (summary.terminals.length) {
		out.push('');
		out.push('Every worktree is clean — nothing uncommitted or unmerged.');
	}
	out.push('');
	out.push(`Closing stops these sessions. The worktree folders stay on disk. ${reopenNote()}`);
	return out.join('\n');
}

/** Everything the dialog needs, from records the caller already chose. */
export function buildCloseConfirm(
	name: string,
	summary: CloseSummary,
	risks: Record<string, WorktreeRisk> = {},
): { title: string; message: string; okLabel: string } {
	return {
		title: `Close workspace "${name}"?`,
		message: closeConfirmMessage(name, summary, risks),
		okLabel: summary.total === 0 ? 'Close' : `Close and stop ${plural(summary.total, 'session')}`,
	};
}
