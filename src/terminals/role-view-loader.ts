/** The thin IO half of the Agent Instruction Interface: read the library folder, hand the bytes
 *  to role-library.ts's parser and role-view.ts's pure logic, and return one snapshot the view
 *  renders. Mirrors role-loader.ts, which does the same job for a session's system prompt.
 *
 *  Nothing here throws. The library lives in OneDrive, where a cloud-only placeholder can stall
 *  or fail outright on read, and a wiki that cannot open is a worse outcome than a wiki that
 *  says why it is empty — so every failure becomes a message on the snapshot instead. */

import * as fs from 'fs';
import * as path from 'path';
import { indexRoles, pickRole } from './role-library';
import { readRoleFiles } from './role-loader';
import { buildLibrary, parseRegistry, ancestorDirs, type Library } from './role-view';

/** The registry lives beside the roles it registers. Not configurable: the Charter puts both in
 *  `_meta/agents/`, and a second path to configure is a second thing to get wrong. */
const REGISTRY_FILE = 'Index.md';

/** The one state-changing action in the whole view spawns a terminal on this role. */
export const CUSTODIAN_SLUG = 'agent-custodian';

export interface LibrarySnapshot {
	/** False when config.json has no `roleLibrary` key — the ordinary default, not a failure. */
	configured: boolean;
	path: string | null;
	/** Non-null when the folder is configured but could not be read. */
	error: string | null;
	library: Library;
	/** The Obsidian vault the library sits inside, if any — where a tile's link points. */
	vaultRoot: string | null;
	/** Whether a Custodian terminal can be spawned, and why not when it cannot. */
	custodian: { ok: boolean; reason: string };
}

const EMPTY_LIBRARY: Library = { tiles: [], coverage: { withFile: 0, total: 0 }, unregistered: [], duplicates: [], registryFound: false };

/** Walk up from a path looking for a `.obsidian/` folder. Cheap, needs no configuration, and the
 *  vault's name comes free from the folder name. Null means the library is not in a vault, which
 *  is a normal answer, not an error. */
export function findVaultRoot(startPath: string): string | null {
	// ancestorDirs() takes a FILE path, so join a sentinel to have the folder itself considered.
	for (const dir of ancestorDirs(path.join(startPath, 'x'))) {
		try { if (fs.existsSync(path.join(dir, '.obsidian'))) return dir; } catch { /* unreadable ancestor — keep walking */ }
	}
	return null;
}

/** The registry text, or null. Read by name; on a case-sensitive filesystem, fall back to a
 *  case-insensitive scan, because `index.md` and `Index.md` are the same file to the vault. */
function readRegistry(dir: string): string | null {
	try { return fs.readFileSync(path.join(dir, REGISTRY_FILE), 'utf8'); } catch { /* try harder below */ }
	try {
		const match = fs.readdirSync(dir).find((n) => n.toLowerCase() === REGISTRY_FILE.toLowerCase());
		return match ? fs.readFileSync(path.join(dir, match), 'utf8') : null;
	} catch { return null; }
}

/** Everything the view needs, from one read of the folder. `libraryPath` is config.json's
 *  `roleLibrary.path`; undefined means no library is configured, which the view explains rather
 *  than rendering blank. */
export function readLibrary(libraryPath: string | undefined): LibrarySnapshot {
	const base: LibrarySnapshot = {
		configured: !!libraryPath,
		path: libraryPath ?? null,
		error: null,
		library: EMPTY_LIBRARY,
		vaultRoot: null,
		custodian: { ok: false, reason: 'no role library configured' },
	};
	if (!libraryPath) return base;
	try {
		let files: { name: string; text: string }[];
		try {
			files = readRoleFiles(libraryPath);
		} catch (e) {
			return { ...base, error: `Could not read ${libraryPath} — ${(e as Error)?.message ?? e}`, custodian: { ok: false, reason: 'the library folder could not be read' } };
		}
		const index = indexRoles(files);
		const custodian = pickRole(index, CUSTODIAN_SLUG);
		return {
			...base,
			library: buildLibrary(index, parseRegistry(readRegistry(libraryPath))),
			vaultRoot: findVaultRoot(libraryPath),
			custodian: custodian.ok ? { ok: true, reason: '' } : { ok: false, reason: custodian.reason },
		};
	} catch (e) {
		// Outer guard: opening the wiki must not be able to take the app down.
		return { ...base, error: `Could not read the role library — ${(e as Error)?.message ?? e}`, custodian: { ok: false, reason: 'the library could not be read' } };
	}
}

/** The absolute path of one role file inside the library. */
export function roleFilePath(libraryPath: string, file: string): string {
	return path.join(libraryPath, file);
}
