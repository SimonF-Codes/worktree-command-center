/** The thin IO half of the role library: read the vault folder, hand the bytes to the pure
 *  functions in role-library.ts, and return a finished prompt — or null, which ALWAYS means
 *  "the caller falls back to its built-in string builder". Both call sites (terminal-tile's
 *  writeContextFile and god-console's writeSystemPromptFile) treat null exactly that way, which
 *  is why the log line below can name the fallback from in here.
 *
 *  Every failure falls back and none of them throw. An agent that starts with NO instructions is
 *  far worse than one running a slightly stale compiled default, and these files live in OneDrive
 *  — a cloud-only placeholder can fail outright on read — so a vault hiccup must never be able to
 *  break a session start. */

import * as fs from 'fs';
import * as path from 'path';
import { indexRoles, pickRole, buildPrompt, type SessionFact } from './role-library';

/** Bounds on what the loader will pull into memory. The folder is a handful of hand-written
 *  markdown files; anything past these limits is a wrong path in config, not a role library. */
const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

/** One line per session start naming the role and where its instructions came from. Without it a
 *  silently-failing loader is indistinguishable from a working one — every session would look
 *  fine while quietly running the compiled defaults, and the whole feature would appear to work
 *  while doing nothing. A configured-but-unusable library warns; having no library configured at
 *  all is the ordinary default, so it only logs. */
function report(slug: string, source: string, configured: boolean): void {
	const line = `[roles] ${slug} — ${source}`;
	if (configured && !source.startsWith('vault')) console.warn(line);
	else console.log(line);
}

/** Read every `*.md` in the library folder. One unreadable file (a stalled OneDrive placeholder,
 *  a permissions oddity) skips that file rather than losing the rest — the role we want may well
 *  be one of the ones that read fine. */
function readRoleFiles(dir: string): { name: string; text: string }[] {
	const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).slice(0, MAX_FILES);
	const files: { name: string; text: string }[] = [];
	for (const name of names) {
		const full = path.join(dir, name);
		try {
			if (fs.statSync(full).size > MAX_BYTES) continue;
			files.push({ name, text: fs.readFileSync(full, 'utf8') });
		} catch { /* skip this one file */ }
	}
	return files;
}

/** The appended system prompt for `slug`, or null to use the built-in builder.
 *  `libraryPath` is config.json's `roleLibrary.path`; undefined means no library configured. */
export function loadRolePrompt(libraryPath: string | undefined, slug: string, facts: SessionFact[]): string | null {
	const configured = !!libraryPath;
	try {
		if (!libraryPath) { report(slug, 'built-in (no roleLibrary configured)', false); return null; }
		let files: { name: string; text: string }[];
		try {
			files = readRoleFiles(libraryPath);
		} catch (e) {
			report(slug, `built-in (role library unreadable: ${(e as Error)?.message ?? e})`, true);
			return null;
		}
		const index = indexRoles(files);
		if (index.duplicates.length) {
			// Last file wins, so the prompt is still usable — but one of those files is silently
			// dead, which is a thing the vault's Custodian needs told.
			console.warn(`[roles] duplicate role slug(s) in ${libraryPath}: ${index.duplicates.join(', ')} — last file wins`);
		}
		const found = pickRole(index, slug);
		if (!found.ok) { report(slug, `built-in (${found.reason})`, true); return null; }
		report(slug, `vault (${found.role.file})`, true);
		return buildPrompt(found.role, facts);
	} catch (e) {
		// Outer guard: nothing above is allowed to throw into a session start.
		try { report(slug, `built-in (role load failed: ${(e as Error)?.message ?? e})`, configured); } catch { /* logging must not throw either */ }
		return null;
	}
}
