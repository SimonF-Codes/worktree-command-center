/** The thin IO half of delegation: read the role library and hand core/delegation.ts a lookup of
 *  the ACTIVE role files' `authority:` and `spawns:`. Everything it decides is decided there.
 *
 *  The one and only source of delegation authority is this folder. No environment variable is read
 *  here or anywhere downstream of it — worker tiles once inherited COS_ROLE=god, and every one ran
 *  with god authority, so an env-derived "role" is exactly what this must never trust.
 *
 *  Cached for a few seconds per library path: the sidebar asks every 1.5s and the folder lives in
 *  OneDrive. A role file edited in Obsidian is picked up within REREAD_MS — the role FILE is the
 *  authority, read live, not a copy taken when a session started. */

import { indexRoles, pickRole } from './role-library';
import { readRoleFiles } from './role-loader';
import { delegationRoleOf, lookupFrom, type DelegationRole, type RoleLookup } from '../core/delegation';

const REREAD_MS = 5000;
const NONE: RoleLookup = () => undefined;
let cache: { path: string; at: number; lookup: RoleLookup } | null = null;

/** Every active role in the library, as delegation sees it. Never throws: an unreadable library is
 *  "no role files", which makes every check fail closed (checkDelegationBySlug 'role-file'). */
export function readDelegationRoles(libraryPath: string | undefined): DelegationRole[] {
	if (!libraryPath) return [];
	try {
		const index = indexRoles(readRoleFiles(libraryPath));
		const out: DelegationRole[] = [];
		for (const slug of index.roles.keys()) {
			const found = pickRole(index, slug);
			if (found.ok) out.push(delegationRoleOf(slug, found.role.frontmatter));
		}
		return out;
	} catch {
		return [];
	}
}

/** The lookup for a library, re-read at most every REREAD_MS. `now` is for tests. */
export function delegationLookup(libraryPath: string | undefined, now: number = Date.now()): RoleLookup {
	if (!libraryPath) return NONE;
	if (cache && cache.path === libraryPath && now - cache.at < REREAD_MS) return cache.lookup;
	const lookup = lookupFrom(readDelegationRoles(libraryPath));
	cache = { path: libraryPath, at: now, lookup };
	return lookup;
}
