// Types for claims-core.cjs, so the app imports the hook's own logic instead of mirroring it.
export interface ClaimRecord {
  v?: number; resource: string; checkoutId?: string; path: string; sessionId: string; holderId?: string;
  holder: string; mode?: string; reason?: string; pid?: number; ts: number; ttlMs: number;
}
export type WriteVerdict =
  | { verdict: 'allow' }
  | { verdict: 'claim'; escalate: boolean }
  | { verdict: 'deny'; reason: string; holder: string; path: string };
export const CLAIM_TTL_MS: number;
export const WORKTREES_DIR: string;
export const MODES: readonly string[];
export function checkoutId(p: string): string;
export function writeResource(id: string): string;
export function claimFileName(id: string): string;
export function isInside(target: string, root: string): boolean;
export function claimCovers(claim: ClaimRecord | null | undefined, target: string): boolean;
export function claimIsLive(claim: { ts: number; ttlMs?: number } | null, now: number): boolean;
export function canEscalate(policy: string | undefined, rung: string | undefined, taskClass: string | undefined): boolean;
export function decideWrite(i: {
  mode?: string; checkout?: string; sessionId?: string; policy?: string; rung?: string; taskClass?: string;
  target: string; claims: readonly ClaimRecord[]; now: number;
}): WriteVerdict;
export function heldMessage(holder: ClaimRecord | null, checkout: string, target: string, now: number): string;
export function failClosedMessage(mode: string | undefined, target: string, err: string): string;
export function releaseRefusal(porcelain: string | null, checkout: string): string | null;
export function toolTarget(input: unknown): string;
export function ageStr(ms: number): string;
