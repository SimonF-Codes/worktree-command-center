/** Pure logic for the closed-workspace archive — no IO/DOM, so it unit-tests cleanly.
 *
 *  Closing a tab used to run three hard deletes with no tombstone: the workspace entry
 *  (workspace-store closeWorkspace), the tile list (`delete all[group]` in forgetGroup) and the
 *  toolbar state (pruneToolbars). Nothing wrote a record, so nothing could bring a tab back.
 *
 *  Those deletes were themselves a deliberate fix — closing a tab used to LEAK its sessions
 *  bucket forever, and the live sessions file still carries a `test-2` bucket for a tab deleted
 *  weeks ago. Cleanup was right; making cleanup synonymous with destruction was the mistake. So
 *  this archives rather than deletes, and stays bounded: the cap evicts the oldest entry, and an
 *  evicted entry must take its sessions key with it or the leak is back. */

import type { ToolbarState } from './toolbar-state';

export interface ClosedWorkspace {
	id: string;
	name: string;
	/** ms epoch of the close — also the tiebreak that orders the archive. */
	closedAt: number;
	/** The key the tab's tiles were RENAMED to inside .terminal-sessions.json. The records stay
	 *  in the file the serializer already writes; config.json holds only this pointer, not
	 *  eighteen tile records per archived tab. */
	sessionsKey: string;
	/** Where the tab sat in the bar, so restoring puts it back rather than appending it. */
	index: number;
	/** How many sessions it held, for the Recently closed list — reading the sessions file to
	 *  render a menu would be silly. */
	tileCount: number;
	toolbar?: ToolbarState;
	/** The tab's linked repo path (Workspace.repo), so a restored tab comes back still linked. */
	repo?: string;
}

/** Bounded on purpose: config.json is rewritten on almost every interaction, so a tombstone
 *  that grows without limit is a different bug. */
export const CLOSED_WORKSPACES_CAP = 10;

/** The archived key for a group's tiles. Prefixed so it can never collide with a live workspace
 *  id (slugId strips ':') and is obvious to anyone reading the file. */
export function archiveSessionsKey(id: string, closedAt: number): string {
	return `closed:${id}:${closedAt}`;
}

export function isArchiveSessionsKey(key: string): boolean {
	return String(key).startsWith('closed:');
}

function normalizeOne(raw: unknown): ClosedWorkspace | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string' || !o.id) return null;
	if (typeof o.sessionsKey !== 'string' || !o.sessionsKey) return null;
	const closedAt = typeof o.closedAt === 'number' && Number.isFinite(o.closedAt) ? o.closedAt : 0;
	const entry: ClosedWorkspace = {
		id: o.id,
		name: typeof o.name === 'string' && o.name ? o.name : o.id,
		closedAt,
		sessionsKey: o.sessionsKey,
		index: typeof o.index === 'number' && o.index >= 0 ? Math.floor(o.index) : 0,
		tileCount: typeof o.tileCount === 'number' && o.tileCount >= 0 ? Math.floor(o.tileCount) : 0,
	};
	if (o.toolbar && typeof o.toolbar === 'object') entry.toolbar = { ...(o.toolbar as ToolbarState) };
	if (typeof o.repo === 'string' && o.repo) entry.repo = o.repo;
	return entry;
}

/** Most recent first, deduped by sessionsKey, capped. Junk entries are dropped rather than
 *  offered as a restore that cannot work. */
export function normalizeClosedWorkspaces(raw: unknown): ClosedWorkspace[] {
	if (!Array.isArray(raw)) return [];
	const out: ClosedWorkspace[] = [];
	for (const r of raw) {
		const e = normalizeOne(r);
		if (e && !out.some((x) => x.sessionsKey === e.sessionsKey)) out.push(e);
	}
	out.sort((a, b) => b.closedAt - a.closedAt);
	return out.slice(0, CLOSED_WORKSPACES_CAP);
}

/** Add a tombstone. Returns the new list AND whatever fell off the end — the caller must delete
 *  each evicted entry's sessions key, or archiving just moves the leak to a new name. */
export function archiveWorkspace(
	archive: ClosedWorkspace[],
	entry: ClosedWorkspace,
): { list: ClosedWorkspace[]; evicted: ClosedWorkspace[] } {
	const kept = archive.filter((e) => e.sessionsKey !== entry.sessionsKey);
	const all = [entry, ...kept].sort((a, b) => b.closedAt - a.closedAt);
	return { list: all.slice(0, CLOSED_WORKSPACES_CAP), evicted: all.slice(CLOSED_WORKSPACES_CAP) };
}

/** Pull one entry out for a restore. Null when it is already gone (double-click on Undo). */
export function takeClosedWorkspace(
	archive: ClosedWorkspace[],
	sessionsKey: string,
): { entry: ClosedWorkspace; list: ClosedWorkspace[] } | null {
	const entry = archive.find((e) => e.sessionsKey === sessionsKey);
	if (!entry) return null;
	return { entry, list: archive.filter((e) => e.sessionsKey !== sessionsKey) };
}

/** Put a restored tab back where it was, tolerating an archive older than the current bar. */
export function insertAt<T>(list: T[], item: T, index: number): T[] {
	const i = Math.max(0, Math.min(Number.isFinite(index) ? index : list.length, list.length));
	return [...list.slice(0, i), item, ...list.slice(i)];
}
