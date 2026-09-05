/** Pure helpers for the role library — agent instructions read from markdown files in Simon's
 *  vault instead of from string literals compiled into this bundle. No fs here (see
 *  role-loader.ts for the thin IO wrapper), so every rule below unit-tests directly.
 *
 *  A role file is governed by the vault's `_meta/agents/Charter.md`: frontmatter with a stable
 *  `role:` slug plus a `status:`, then prose. This module only cares about three of those fields
 *  — the slug is the join key, the status gates loading, and the body becomes the prompt. The
 *  rest of the Charter (which headings must be present, the authority ladder) is the Custodian's
 *  business, not this app's: an app that enforced the schema would refuse to load a role file a
 *  human just edited, which is exactly the failure mode the built-in fallback exists to avoid.
 *
 *  Runtime values (repo, branch, worktree path, the floor's targets) are NOT templated into the
 *  prose. They are appended as a "Session facts" block, because role files are read by a person
 *  in Obsidian and a `{{placeholder}}` syntax would clutter the document, invent a parser, and
 *  break silently when someone edits around it. */

/** One role file's frontmatter + prose, fence stripped. */
export interface ParsedRoleFile {
	frontmatter: Record<string, string>;
	body: string;
}

/** An indexed role: what the loader needs to decide whether to use it and to say where it
 *  came from. `file` is carried purely so the log line can name it. */
export interface Role {
	slug: string;
	status: string;
	body: string;
	file: string;
}

/** Split a role file into frontmatter + body. The fence must be the first thing in the file
 *  (a UTF-8 BOM aside — Obsidian and OneDrive both hand those back). Returns null rather than
 *  throwing on a malformed or absent fence: a file that is not a role file is an ordinary
 *  condition in a folder a person edits, not an error. */
export function parseRoleFile(text: string): ParsedRoleFile | null {
	const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
	if (lines[0]?.trim() !== '---') return null;
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (end === -1) return null;
	const frontmatter: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const at = line.indexOf(':');
		if (at <= 0) continue;
		const key = line.slice(0, at).trim().toLowerCase();
		if (!key) continue;
		// Strip a trailing ` # comment`: the Charter documents the frontmatter with inline
		// comments, so a role file copied from that template would otherwise index its slug as
		// "alpha    # stable slug, lowercase-hyphen…". Only ` #` (whitespace first) counts, so a
		// value that legitimately contains a hash survives.
		frontmatter[key] = line.slice(at + 1).replace(/\s+#.*$/, '').trim();
	}
	return { frontmatter, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '').trimEnd() };
}

/** Every parseable role, keyed by slug, plus any slug that appeared more than once. Duplicates
 *  are last-wins (the caller still gets a working prompt) but they are a Custodian-relevant
 *  condition — two files claiming one slug means one of them is silently dead — so they are
 *  reported back rather than swallowed. */
export interface RoleIndex {
	roles: Map<string, Role>;
	duplicates: string[];
}

/** Index a directory's worth of role files by their `role:` frontmatter slug — NOT by filename.
 *  The slug is the join key across every system that reads this library; filenames are display
 *  names and get renamed in Obsidian without anyone thinking of it as a breaking change. */
export function indexRoles(files: { name: string; text: string }[]): RoleIndex {
	const roles = new Map<string, Role>();
	const duplicates: string[] = [];
	for (const f of files) {
		const parsed = parseRoleFile(f.text);
		if (!parsed) continue;
		const slug = (parsed.frontmatter.role ?? '').trim();
		if (!slug) continue;
		if (roles.has(slug) && !duplicates.includes(slug)) duplicates.push(slug);
		roles.set(slug, { slug, status: (parsed.frontmatter.status ?? '').trim(), body: parsed.body, file: f.name });
	}
	return { roles, duplicates };
}

/** Why a lookup did not produce a usable role — carried so the log line can say which of the
 *  several "fell back to the built-in" cases actually happened. Without that, a library pointed
 *  at the wrong folder and a role marked `proposed` look identical from the outside. */
export type RoleLookup =
	| { ok: true; role: Role }
	| { ok: false; reason: string };

/** Look a slug up, honouring `status`. Only `active` loads: a `proposed` or `retired` directive
 *  is a draft or a tombstone, and neither is meant to be governing a live session. */
export function pickRole(index: RoleIndex, slug: string): RoleLookup {
	const role = index.roles.get(slug);
	if (!role) return { ok: false, reason: `no role file declares role: ${slug}` };
	if (role.status !== 'active') return { ok: false, reason: `${role.file} is status "${role.status || '(unset)'}", not active` };
	if (!role.body.trim()) return { ok: false, reason: `${role.file} has an empty body` };
	return { ok: true, role };
}

/** One runtime value the built-in builders used to interpolate into their prose. */
export interface SessionFact {
	label: string;
	value: string;
}

/** The `## Session facts` block appended under the role's prose. A multi-line value (the floor's
 *  target list) becomes an indented sub-list; an empty one is dropped entirely rather than
 *  rendered as a dangling `- branch:` that reads like a missing value. */
export function renderFacts(facts: SessionFact[]): string {
	const lines = ['## Session facts', ''];
	for (const f of facts) {
		const value = (f.value ?? '').trimEnd();
		if (!value.trim()) continue;
		if (value.includes('\n')) {
			lines.push(`- ${f.label}:`);
			for (const l of value.split('\n')) lines.push(`  ${l}`);
		} else {
			lines.push(`- ${f.label}: ${value}`);
		}
	}
	return lines.join('\n') + '\n';
}

/** The finished appended system prompt: the role's prose, a rule, then the session's facts. */
export function buildPrompt(role: Role, facts: SessionFact[]): string {
	return `${role.body.trim()}\n\n---\n\n${renderFacts(facts)}`;
}

/** Where the role library lives — an optional `roleLibrary` key in config.json. */
export interface RoleLibraryConfig {
	path: string;
}

/** Tolerant parse of config.json's `roleLibrary` key, mirroring parseGodSelfImprove in god.ts.
 *  An absent or malformed key means "use the built-in prompts", never an error — the app must
 *  start for a user who has never heard of the vault. */
export function parseRoleLibrary(v: unknown): RoleLibraryConfig | undefined {
	if (!v || typeof v !== 'object') return undefined;
	const o = v as Record<string, unknown>;
	return typeof o.path === 'string' && o.path.trim() !== '' ? { path: o.path } : undefined;
}
