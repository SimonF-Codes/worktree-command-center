// V2 Team Floor step 11 — the Project panel's pure decisions: whether it is on, whether its lanes
// are (Tree Stage P7), and where it goes.

/** `v2.projectPanel`, default OFF. Off = no 📊 at all; attention.jsonl and workstreams.jsonl keep
 *  being written regardless, so turning it on later has history to show. */
export function parseProjectPanelEnabled(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { projectPanel?: unknown }).projectPanel === true;
}

/** `v2.projectLanes` (Tree Stage step P7), default OFF. Off = the panel's open-work list exactly as
 *  it was before lanes; on = lanes (ui/project-lanes.ts) in its place. Applied live, no restart. */
export function parseProjectLanesEnabled(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { projectLanes?: unknown }).projectLanes === true;
}

/** The panel's width when pinned as a column, in px. A width, not a breakpoint: WHETHER it pins is
 *  decided by panelPlacement below, against the live minimum tile. */
export const PROJECT_PANEL_W = 400;

/** Where the panel opens (D15): pinned beside the stage ONLY when what is left of the stage still
 *  holds one usable terminal — `stageW − panelW ≥ minTileSize(m).w`, the same inequality V2 UI uses
 *  for its rail, measured from live cell metrics (80 columns × the font's real cell width + chrome).
 *  Never a pixel breakpoint: at a bigger font the same window stops pinning, which is the point.
 *  Below that, it opens as a main-pane view, the way Roles does.
 *
 *  `stageW` is the stage as it is NOW; while the panel is pinned that already excludes it, so the
 *  width it would have unpinned is added back — otherwise pinning would flip itself off. */
export function panelPlacement(o: { stageW: number; pinnedNow: boolean; panelW: number; minTileW: number }): 'column' | 'main-pane' {
	const unpinned = o.stageW + (o.pinnedNow ? o.panelW : 0);
	return unpinned - o.panelW >= o.minTileW ? 'column' : 'main-pane';
}

/** How often the panel re-runs wcc-team while it is open (NFR-2: on demand when it opens, and
 *  otherwise at most every five minutes) — the floor report's vault throttle, reused. */
export const METRICS_REFRESH_MS = 5 * 60_000;
