// Types for claims-store.cjs — the machine-wide write-claim store the app, the CLI and the hook share.
import type { ClaimRecord } from './claims-core.cjs';
export type { ClaimRecord };
export interface ClaimHolder { sessionId: string; holder?: string; mode?: string; reason?: string }
export type TakeResult = { ok: true; acquired: true } | { ok: true; renewed: true } | { ok: false; holder: ClaimRecord | null };
export function claimsDirOf(coordDir: string): string;
export function claimPath(dir: string, checkoutId: string): string;
export function ensureClaimsDir(dir: string): string;
export function readClaims(dir: string, opts?: { strict?: boolean }): ClaimRecord[];
export function takeClaim(dir: string, checkout: string, who: ClaimHolder, opts?: { now?: number; ttlMs?: number; boardDir?: string }): TakeResult;
export function renewClaim(dir: string, checkout: string, sessionId: string, opts?: { now?: number }): boolean;
export function releaseClaim(dir: string, checkout: string, sessionId: string, opts?: { boardDir?: string }): ClaimRecord | null;
export function claimsOf(dir: string, sessionId: string): ClaimRecord[];
export function remapClaims(dir: string, remap: (p: string) => string): { changed: number; conflicts: string[] };
