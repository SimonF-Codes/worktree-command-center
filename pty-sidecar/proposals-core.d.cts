// Types for proposals-core.cjs, so the app imports the CLI's own fold instead of mirroring it.
export type ProposalState = 'open' | 'accepted' | 'declined' | 'stale';
export interface SpawnProposal {
  id: string;
  ts: number;
  from: { sessionId: string; role: string; name: string };
  /** The proposer's parent when it was written; null = it was UNASSIGNED. */
  to: string | null;
  toName?: string;
  workstreamId: string | null;
  /** The role slug being asked for. */
  role: string;
  task: string;
  why: string;
  state: ProposalState;
  decidedBy?: string;
  decidedByName?: string;
  decidedTs?: number;
  reason?: string;
  /** accepted: the sessionId it was spawned as. */
  spawned?: string;
}
export type ProposalEvent =
  | ({ ev: 'propose' } & Omit<SpawnProposal, 'state' | 'decidedBy' | 'decidedByName' | 'decidedTs' | 'reason' | 'spawned'>)
  | { ev: 'accept' | 'decline' | 'stale'; ts: number; id: string; by: string | null; byName: string | null; reason: string | null; spawned: string | null };
export const STATES: readonly ProposalState[];
export function parseProposalEvent(line: string): ProposalEvent | null;
export function foldProposals(text: string): SpawnProposal[];
export function proposalKey(role: string, task: string): string;
export function formatProposal(p: SpawnProposal, names?: Record<string, string>): string;
