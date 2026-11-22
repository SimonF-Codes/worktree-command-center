// V2 Team Floor step 10 — delegation. Pure: no window, no fs, no clock, and NO environment.
//
// The Charter's §Delegation, as a function. A parent role P may spawn a child role C only when
// all three hold:
//
//   1. C is listed in P.spawns.
//   2. rung(C) <= rung(P) on observer < proposer < operator < autonomous.
//   3. C.spawns is a subset of P.spawns.
//
// An absent or empty `spawns:` means the role starts nothing. Delegation narrows, never widens —
// the ladder's own monotone rule — so it is audited by checking a property, not by judgement.
//
// Every input here comes from ROLE FILES (their frontmatter, parsed by role-library.ts). Nothing
// reads COS_ROLE or any other variable: worker tiles once inherited COS_ROLE=god from the
// overseer's environment and every one of them ran with god authority (session-env.ts carries
// the story). An env gate has leaked once; this one cannot, because it has no env to read.

/** The four rungs, lowest first. There are no others (Charter §The authority ladder). */
export const RUNGS = ['observer', 'proposer', 'operator', 'autonomous'] as const;
export type Rung = typeof RUNGS[number];

/** A rung's place on the ladder, or -1 for anything that is not exactly one of the four. */
export function rungIndex(authority: string | undefined): number {
	return (RUNGS as readonly string[]).indexOf((authority ?? '').trim().toLowerCase());
}

/** Parse a role file's `spawns:` value into slugs. Accepts the Charter's inline list
 *  (`[worker-terminal, researcher]`), a bare comma list (`worker-terminal, researcher`), and the
 *  comma-joined form role-library's parser makes of a YAML block list. Quotes are stripped, case
 *  is folded (slugs are lowercase-hyphen), blanks and duplicates dropped. Absent or empty → []. */
export function parseSpawns(value: string | undefined): string[] {
	const raw = (value ?? '').trim().replace(/^\[/, '').replace(/\]$/, '');
	const out: string[] = [];
	for (const part of raw.split(',')) {
		const slug = part.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
		if (slug && !out.includes(slug)) out.push(slug);
	}
	return out;
}

/** What delegation needs from one role file. */
export interface DelegationRole {
	slug: string;
	/** The `authority:` value as written — checked against RUNGS, never trusted. */
	authority: string;
	spawns: readonly string[];
}

/** Read the delegation fields out of a role file's frontmatter (role-library ParsedRoleFile). */
export function delegationRoleOf(slug: string, frontmatter: Readonly<Record<string, string>>): DelegationRole {
	return { slug, authority: (frontmatter['authority'] ?? '').trim(), spawns: parseSpawns(frontmatter['spawns']) };
}

/** A role is a manager exactly when its role file says it may start something. Authority, not
 *  shape: having children does not make a session one, and having none does not unmake it. */
export function isManager(role: DelegationRole | undefined): boolean {
	return !!role && role.spawns.length > 0;
}

/** Which of the Charter's three conditions failed — or, before any of them can be checked, that a
 *  role file was missing ('role-file'). */
export type DelegationCondition = 'listed' | 'rung' | 'subset' | 'role-file';

export type DelegationResult =
	| { ok: true }
	| { ok: false; condition: DelegationCondition; reason: string };

const LADDER = RUNGS.join(' < ');
const list = (xs: readonly string[]): string => (xs.length ? xs.join(', ') : 'none');

/** The Charter's three checks, in order; the first that fails is the one reported. A refusal
 *  always names its condition — one that does not say which of the three failed is a dead end
 *  for whoever hit it. */
export function checkDelegation(parent: DelegationRole, child: DelegationRole): DelegationResult {
	const head = `${parent.slug} may not spawn ${child.slug}`;
	if (!parent.spawns.includes(child.slug)) {
		return {
			ok: false, condition: 'listed',
			reason: parent.spawns.length
				? `${head} — condition 1 of 3 (listed): ${child.slug} is not in ${parent.slug}'s spawns: (${list(parent.spawns)})`
				: `${head} — condition 1 of 3 (listed): ${parent.slug} has no spawns:, so it starts nothing`,
		};
	}
	const p = rungIndex(parent.authority), c = rungIndex(child.authority);
	if (p < 0 || c < 0) {
		const bad = p < 0 ? parent : child;
		return {
			ok: false, condition: 'rung',
			reason: `${head} — condition 2 of 3 (rung): ${bad.slug}'s authority: is "${bad.authority || '(unset)'}", not one rung of ${LADDER}`,
		};
	}
	if (c > p) {
		return {
			ok: false, condition: 'rung',
			reason: `${head} — condition 2 of 3 (rung): ${child.slug} is ${RUNGS[c]}, above ${parent.slug}'s ${RUNGS[p]} (${LADDER})`,
		};
	}
	const widened = child.spawns.filter((s) => !parent.spawns.includes(s));
	if (widened.length) {
		return {
			ok: false, condition: 'subset',
			reason: `${head} — condition 3 of 3 (subset): ${child.slug}'s spawns: would widen ${parent.slug}'s by ${list(widened)}`,
		};
	}
	return { ok: true };
}

/** Find a role by slug: only ACTIVE role files count (a proposed or retired role governs nothing). */
export type RoleLookup = (slug: string) => DelegationRole | undefined;

/** checkDelegation by slug, for callers that hold sessions rather than role files. A role with no
 *  active file cannot be checked — so it fails, closed, and says which file is missing. A session
 *  on such a slug runs on a compiled default the role library cannot vouch for. */
export function checkDelegationBySlug(lookup: RoleLookup, parentSlug: string, childSlug: string): DelegationResult {
	const parent = lookup(parentSlug);
	const child = lookup(childSlug);
	const missing = !parent ? parentSlug : !child ? childSlug : null;
	if (missing !== null || !parent || !child) {
		return {
			ok: false, condition: 'role-file',
			reason: `${parentSlug} may not spawn ${childSlug} — no active role file declares role: ${missing}, and delegation is checked against role files only`,
		};
	}
	return checkDelegation(parent, child);
}

/** A lookup over a fixed set of roles — what the app builds from the role index, and what tests
 *  build by hand. */
export function lookupFrom(roles: Iterable<DelegationRole>): RoleLookup {
	const m = new Map<string, DelegationRole>();
	for (const r of roles) m.set(r.slug, r);
	return (slug) => m.get(slug);
}

// ---- The setting: config.json `v2.managers`. Default OFF.
//
// Off is today exactly: the app refuses every non-overseer spawn, the tree marks no managers and
// checks no edges. Only an explicit `true` turns it on.

export function parseManagersEnabled(v2: unknown): boolean {
	if (!v2 || typeof v2 !== 'object') return false;
	return (v2 as { managers?: unknown }).managers === true;
}

/** The refusal every session-channel request gets while `v2.managers` is off. */
export const MANAGERS_OFF_REASON = 'manager delegation is off (Settings → Sidebar → Managers, config v2.managers) — only the overseer may spawn';
