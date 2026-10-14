/** `<coordDir>/floor/state.json` — the machine-readable twin of `floor/INDEX.md`.
 *
 *  INDEX.md is for people (and Kane) to read; anything outside the app that wanted the roster had
 *  to regex markdown. This is the same roster as JSON, built from the SAME snapshot pass that
 *  writes INDEX.md (TerminalsGrid.writeFloorSnapshot) — one writer, one timer, no second poll —
 *  so the two files can never disagree about who is on the floor.
 *
 *  It also carries the worktree ledger that `worktrees.md` renders, taken from the grid's last
 *  finished scan (no new scan is run for it). The same argument applies to that file as to
 *  INDEX.md: it's markdown an outside caller would otherwise have to parse. The scan runs on its
 *  own 30s cadence, so it gets its own `scannedAt` rather than borrowing the snapshot's `ts`.
 *
 *  Versioned like the connector request envelopes (`v: 1`). Additive changes keep v1; a field
 *  that changes meaning or disappears bumps it. */

import { computeState, type WorktreeEntry } from './worktree-registry';

export const FLOOR_STATE_VERSION = 1;
export const FLOOR_STATE_FILE = 'state.json';

/** `terminal` — a worktree (or folder) session a connector can `tell`. `journal` — a journal
 *  tile: on the roster, never addressable. `god` — an overseer console: listed so a caller can
 *  see it exists, but it is not on the connector's `tell` roster and never will be. */
export type FloorStateKind = 'terminal' | 'journal' | 'god';

export interface FloorStateTerminal {
	/** The tile id; `0`/negative for overseer consoles (their COS_TERMINAL_ID). */
	id: number;
	/** Exact live name — the value a connector `tell` addresses. */
	name: string;
	kind: FloorStateKind;
	repo: string | null;
	branch: string | null;
	worktreePath: string | null;
	/** True mid-turn, false idle; null when the app doesn't track it (journals, overseers). */
	busy: boolean | null;
	/** Minimized off the stage — still a live session. */
	hidden: boolean;
	/** Whether a connector `tell` can address it — exactly `kind === 'terminal'`. */
	tellable: boolean;
	/** The per-terminal snapshot beside this file (`floor/<file>`), or null when none is written. */
	snapshotFile: string | null;
}

export interface FloorStateWorktree {
	repo: string;
	branch: string;
	path: string;
	/** The live terminal holding it, or null — a worktree nobody holds. */
	terminal: string | null;
	state: 'clean' | 'dirty' | 'ahead' | 'parked';
	dirtyFiles: number;
	ahead: number;
	behind: number;
	/** The ref ahead/behind count against; equal to `branch` when no base could be told. */
	base: string | null;
	lastCommitAt: number | null;
}

export interface FloorState {
	v: typeof FLOOR_STATE_VERSION;
	workspaceId: string;
	/** When this snapshot was taken (epoch ms). */
	ts: number;
	/** How often the app rewrites the file while its floor feed runs — a reader judges staleness
	 *  against this rather than hard-coding the app's cadence. */
	intervalMs: number;
	terminals: FloorStateTerminal[];
	/** From the last worktree scan; `scannedAt` null means this workspace hasn't finished one yet,
	 *  which is not the same as "no worktrees". */
	worktrees: { scannedAt: number | null; entries: FloorStateWorktree[] };
}

/** What the grid hands over per session — already resolved, so this module stays IO-free. */
export interface FloorStateInput {
	workspaceId: string;
	ts: number;
	intervalMs: number;
	sessions: Array<Omit<FloorStateTerminal, 'tellable'>>;
	scannedAt: number | null;
	worktrees: WorktreeEntry[];
}

export function buildFloorState(input: FloorStateInput): FloorState {
	return {
		v: FLOOR_STATE_VERSION,
		workspaceId: input.workspaceId,
		ts: input.ts,
		intervalMs: input.intervalMs,
		terminals: input.sessions.map((s) => ({ ...s, tellable: s.kind === 'terminal' })),
		worktrees: {
			scannedAt: input.scannedAt,
			entries: input.scannedAt === null ? [] : input.worktrees.map((e) => ({
				repo: e.repo,
				branch: e.branch,
				path: e.path,
				terminal: e.terminal,
				state: computeState(e),
				dirtyFiles: e.dirtyFiles.length,
				ahead: e.ahead,
				behind: e.behind,
				base: e.base ?? null,
				lastCommitAt: e.lastCommitAt,
			})),
		},
	};
}

/** Pretty-printed with a trailing newline: it's read by programs, but people open it too. */
export function renderFloorState(state: FloorState): string {
	return JSON.stringify(state, null, 2) + '\n';
}
