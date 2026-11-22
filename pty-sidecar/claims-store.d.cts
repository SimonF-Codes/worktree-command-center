// Types for claims-store.cjs — the machine-wide write-claim store the app, the CLI and the hook share.
import type { ClaimRecord } from './claims-core.cjs';
export type { ClaimRecord };
export interface ClaimHolder { sessionId: string; holder?: string; mode?: string; reason?: string }
export type TakeResult = { ok: true; acquired: true } | { ok: true; renewed: true } | { ok: false; holder: ClaimRecord | null };
export function claimsDirUnder(coordRoot: string): string;
export function claimsDirOf(coordDir: string): string;
export function claimPath(dir: string, checkoutId: string): string;
export function ensureClaimsDir(dir: string): string;
export function readClaims(dir: string, opts?: { strict?: boolean }): ClaimRecord[];
export function takeClaim(dir: string, checkout: string, who: ClaimHolder, opts?: { now?: number; ttlMs?: number; boardDir?: string }): TakeResult;
export function renewClaim(dir: string, checkout: string, sessionId: string, opts?: { now?: number }): boolean;
export function releaseClaim(dir: string, checkout: string, sessionId: string, opts?: { boardDir?: string }): ClaimRecord | null;
export function claimsOf(dir: string, sessionId: string): ClaimRecord[];
export function remapClaims(dir: string, remap: (p: string) => string): { changed: number; conflicts: string[] };
import type { RepoIdentity } from './claims-core.cjs';
/** An automatic git lock (`push:<repo>` / `worktree:<repo>`) as stored in `_claims/`. */
export interface GitLockRecord { v?: number; resource: string; repo: string; holder: string; holderId: string; reason?: string; pid?: number; ts: number; ttlMs: number }
export function gitLockPath(dir: string, kind: string, key: string): string;
export function takeGitLock(dir: string, kind: 'push' | 'worktree', repo: RepoIdentity, who: { holderId: string; holder?: string }, opts?: { waitMs?: number; pollMs?: number; now?: number; ttlMs?: number; reason?: string; boardDir?: string }): { ok: true; mine?: true } | { ok: false; holder: GitLockRecord | null };
export function releaseGitLock(dir: string, kind: 'push' | 'worktree', repo: RepoIdentity, holderId: string, opts?: { boardDir?: string }): GitLockRecord | null;
export function readGitLocks(dir: string): GitLockRecord[];
