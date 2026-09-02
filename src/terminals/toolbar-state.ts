/** Pure per-workspace spawn-toolbar state — no IO/DOM, so it unit-tests cleanly.
 *
 *  The repo/branch/model/effort dropdowns used to be pure DOM state, rebuilt from scratch by
 *  every TerminalsGrid.mount(). Sessions deliberately survive a tab switch, but the toolbar did
 *  not: switching away and back reset the repo to the first in the list and the branch to
 *  main/master, so "which target is this tab for" was forgotten constantly — and forgotten
 *  again on every app restart. Keeping it per workspace (not app-wide) is the point: a tab IS
 *  the unit of work, so each one remembers its own target. */

export interface ToolbarState { repo?: string; branch?: string; model?: string; effort?: string; }

/** workspace id → that tab's remembered toolbar selection. */
export type WorkspaceToolbars = Record<string, ToolbarState>;

const KEYS = ['repo', 'branch', 'model', 'effort'] as const;

/** Keep only string-valued known keys; drop empties so an unset dropdown ('' = inherit the CLI
 *  default) never persists as a meaningful choice. */
export function normalizeToolbarState(raw: unknown): ToolbarState {
	const out: ToolbarState = {};
	if (!raw || typeof raw !== 'object') return out;
	const o = raw as Record<string, unknown>;
	for (const k of KEYS) if (typeof o[k] === 'string' && o[k]) out[k] = o[k] as string;
	return out;
}

export function normalizeToolbars(raw: unknown): WorkspaceToolbars {
	const out: WorkspaceToolbars = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!id) continue;
		const s = normalizeToolbarState(v);
		if (Object.keys(s).length) out[id] = s;
	}
	return out;
}

/** Immutable set — a workspace whose selection is now entirely empty drops out of the map
 *  rather than persisting as `{}`. */
export function setToolbarState(all: WorkspaceToolbars, wsId: string, state: ToolbarState): WorkspaceToolbars {
	const next = { ...all };
	const s = normalizeToolbarState(state);
	if (Object.keys(s).length) next[wsId] = s; else delete next[wsId];
	return next;
}

/** Drop entries for workspaces that no longer exist (closing a tab used to leave its state
 *  behind forever, the same leak as the orphaned session buckets). */
export function pruneToolbars(all: WorkspaceToolbars, liveIds: string[]): WorkspaceToolbars {
	const live = new Set(liveIds);
	const out: WorkspaceToolbars = {};
	for (const [id, s] of Object.entries(all)) if (live.has(id)) out[id] = s;
	return out;
}
