// Types for workstreams-core.cjs, so the app and wcc-team import the CLI's own fold instead of mirroring it.
export type TaskState = 'todo' | 'doing' | 'blocked' | 'done' | 'dropped';
export interface Task {
  id: string;
  title: string;
  state: TaskState;
  /** sessionId (or the name it was given), or null for unassigned. */
  owner: string | null;
  opened: number;
  closed?: number;
  /** A vault note path, when one exists. */
  note?: string;
  /** The last state change — what "stale work" is measured from. */
  changed: number;
  blockedReason?: string;
}
export type WorkstreamState = 'open' | 'landed' | 'dropped';
export interface Workstream {
  id: string;
  title: string;
  state: WorkstreamState;
  owner: string | null;
  opened: number;
  closed?: number;
  updated: number;
  openedBy: string | null;
  note?: string;
  commit?: string;
  branch?: string;
  closeReason?: string;
  /** Every reopen of a closed workstream: when, and what it had been. The rework half of FR-40. */
  reopens: Array<{ ts: number; from: 'landed' | 'dropped'; closed?: number; reason?: string }>;
  tasks: Task[];
}
export type WorkstreamEvent = Record<string, unknown> & { v: 1; ev: string; ts: number; id: string };
export const TASK_STATES: readonly TaskState[];
export const USAGE: string;
export function parseWorkstreamEvent(line: string): WorkstreamEvent | null;
export function foldWorkstreams(text: string): Workstream[];
export function planWorkstreamCommand(
  argv: readonly string[], all: readonly Workstream[], actor: string | null, now: number,
): { ok: true; event: WorkstreamEvent; say: string } | { ok: false; reason: string };
export function formatWorkstream(w: Workstream, now: number): string;
