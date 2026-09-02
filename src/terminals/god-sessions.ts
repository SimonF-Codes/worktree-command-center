// Persisted-session helpers for the Kane (overseer) consoles. The primary console and every
// duplicate opened with 🜲+ each own a `.god/<group>[-N]` home directory holding a real Claude
// transcript, so every one of them has to come back after a restart — the duplicates used to be
// forgotten entirely, stranding their conversation on disk with no way back to it from the UI.
//
// A duplicate persists as an ordinary `god` record carrying its instance number as `godIndex`.
// The primary is written WITHOUT one, so the file an older build reads still restores exactly
// what that build understands (the primary) and simply ignores the rest.

export const PRIMARY_GOD_INDEX = 1;

/** The shape these helpers need from a persisted session record. */
export interface GodIndexed { kind?: string; godIndex?: number }

/** A `god` record as persisted: the god-specific fields plus the filler a SessionRecord wants. */
export interface GodRecord extends GodIndexed {
	kind: 'god';
	worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string;
}

/** Which console a `god` record refers to. Records written before duplicates were persisted
 *  carry no `godIndex` at all — those are the primary and must keep restoring as the primary, so
 *  nobody's current session breaks on upgrade. An unusable value (0, negative, fractional, NaN,
 *  a string from a hand-edited file) is read the same conservative way. */
export function godIndexOf(rec: GodIndexed): number {
	const n = rec.godIndex;
	return typeof n === 'number' && Number.isInteger(n) && n > PRIMARY_GOD_INDEX ? n : PRIMARY_GOD_INDEX;
}

/** The `god` records to persist for a workspace: the primary when it is open, then one per
 *  duplicate, ordered and de-duplicated so a restore can't build the same console twice. */
export function godRecords(hasPrimary: boolean, extraIndexes: readonly number[]): GodRecord[] {
	const blank = { kind: 'god', worktreePath: '', branch: '', repoName: 'god', repoPath: '', baseBranch: '' } as const;
	const out: GodRecord[] = [];
	if (hasPrimary) out.push({ ...blank });
	for (const n of [...new Set(extraIndexes)].sort((a, b) => a - b)) {
		if (Number.isInteger(n) && n > PRIMARY_GOD_INDEX) out.push({ ...blank, godIndex: n });
	}
	return out;
}

/** Highest instance number already spoken for, across the persisted records AND the
 *  `.god/<group>-N` home directories on disk. The sequence used to live only in memory and reset
 *  to 1 every launch, so the next duplicate re-claimed `.god/<group>-2` — a directory already
 *  holding somebody else's transcript. Directories count even when no record mentions them: a
 *  console whose record was lost still owns its conversation. */
export function highestGodIndex(records: readonly GodIndexed[], godDirNames: readonly string[], group: string): number {
	let max = PRIMARY_GOD_INDEX;
	for (const r of records) if (r.kind === 'god') max = Math.max(max, godIndexOf(r));
	const prefix = `${group}-`;
	for (const name of godDirNames) {
		// `<group>-2` is a duplicate of THIS group; `<group>-2-3` belongs to the group literally
		// named `<group>-2`, which is why only an all-digits remainder counts.
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length);
		if (!/^\d+$/.test(rest)) continue;
		max = Math.max(max, Number(rest));
	}
	return max;
}
