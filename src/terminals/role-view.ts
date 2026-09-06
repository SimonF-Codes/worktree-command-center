/** Pure view logic for the Agent Instruction Interface — the browsable, read-only wiki of every
 *  agent role (design: the vault's `Personal/Code/Designs/Worktree Command Center — Agent
 *  Instruction Interface.md`). No fs and no DOM here, so every rule below unit-tests directly;
 *  role-view-loader.ts is the thin IO half and src/ui/roles-view.ts is the thin DOM half.
 *
 *  Everything this module reasons about arrives from ONE parse of the library — the `RoleIndex`
 *  role-library.ts already builds for the sessions — plus the registry table in the vault's
 *  `Index.md`. It never re-parses a role file its own way: if the view and the running sessions
 *  could disagree about what a role says, the view is the one that would be trusted.
 *
 *  Two joins hold the whole thing together:
 *    - the `role:` slug joins a role file to its registry row, exactly as it does everywhere else;
 *    - a registry row with no file is an UN-MIGRATED role: a real agent whose instructions still
 *      live in some application's source or config, invisible to the Custodian. Those render as
 *      stubs carrying the steps to migrate them, because the gap should be actionable where it is
 *      visible rather than recorded somewhere and forgotten. */

import type { RoleIndex } from './role-library';

// ---------------------------------------------------------------------------------------------
// The registry (Index.md)
// ---------------------------------------------------------------------------------------------

/** One row of the "Agent registry" table in the vault's `Index.md`. This is the list of every
 *  agent on every surface — including the ones with no role file, which is the only place they
 *  are written down at all. */
export interface RegistryRow {
	slug: string;
	name: string;
	surface: string;
	authority: string;
	mission: string;
	cadence: string;
	/** The Status cell as written, e.g. `active — not migrated (src/butler/session.ts)`. */
	statusText: string;
	/** The Charter status word alone (`active` / `proposed` / `retired`), or '' if it is not one. */
	status: string;
}

const STATUS_WORDS = ['active', 'proposed', 'retired'];

/** Strip the markdown a table cell is written in: wikilinks (keeping the display half), bold,
 *  italics and code fences. What is left is the plain text a tile shows. */
export function plainCell(cell: string): string {
	return String(cell)
		.replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2') // [[Path/Note|Display]] → Display
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The stable slug for a role named in the registry. Lowercase-hyphen, per the Charter — which
 *  is also how every existing role file's `role:` field is spelled, so slugifying a registry
 *  name is what joins the two halves of the library. */
export function slugifyRoleName(name: string): string {
	return plainCell(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Split one markdown table row into cells. Leading/trailing pipes are optional. */
function tableCells(line: string): string[] {
	return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

const isTableRow = (line: string): boolean => line.trim().startsWith('|');
const isSeparatorRow = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/** Parse the "Agent registry" table out of `Index.md`. Columns are matched BY HEADER NAME rather
 *  than by position, so adding a column to the table in the vault does not silently shift every
 *  field by one. Returns [] for anything unparseable — a missing or reorganised Index.md degrades
 *  the view to "the role files I can see", never an error. */
export function parseRegistry(text: string | null | undefined): RegistryRow[] {
	if (!text) return [];
	const lines = String(text).replace(/\r\n/g, '\n').split('\n');
	const start = lines.findIndex((l) => /^#{1,6}\s+Agent registry\s*$/i.test(l.trim()));
	if (start === -1) return [];
	const headerAt = lines.findIndex((l, i) => i > start && isTableRow(l));
	if (headerAt === -1) return [];
	// A heading between "## Agent registry" and the table means the table is somewhere else.
	if (lines.slice(start + 1, headerAt).some((l) => /^#{1,6}\s/.test(l))) return [];

	const headers = tableCells(lines[headerAt]!).map((h) => plainCell(h).toLowerCase());
	const col = (name: string): number => headers.indexOf(name);
	const iRole = col('role');
	if (iRole === -1) return [];
	const cellAt = (cells: string[], i: number): string => (i === -1 ? '' : plainCell(cells[i] ?? ''));

	const rows: RegistryRow[] = [];
	for (let i = headerAt + 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (!isTableRow(line)) break; // the table ended
		if (isSeparatorRow(line)) continue;
		const cells = tableCells(line);
		const name = cellAt(cells, iRole);
		const slug = slugifyRoleName(name);
		if (!slug) continue;
		const statusText = cellAt(cells, col('status'));
		rows.push({
			slug,
			name,
			surface: cellAt(cells, col('surface')),
			authority: cellAt(cells, col('authority')).toLowerCase(),
			mission: cellAt(cells, col('mission')),
			cadence: cellAt(cells, col('cadence')),
			statusText,
			status: STATUS_WORDS.find((w) => statusText.toLowerCase().startsWith(w)) ?? '',
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------------------------

/** The text under one `## Heading`, up to the next heading of any level. */
export function sectionText(body: string, heading: string): string {
	const lines = String(body).replace(/\r\n/g, '\n').split('\n');
	const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'i').test(l.trim()));
	if (at === -1) return '';
	const out: string[] = [];
	for (let i = at + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]!)) break;
		out.push(lines[i]!);
	}
	return out.join('\n').trim();
}

/** The first paragraph of a block of prose, as one line. Callouts and blockquotes (`> [!note]`)
 *  are skipped rather than returned: the Charter's house style opens several sections with one,
 *  and a tile summary that reads "[!important] This file is not modifiable…" describes the file's
 *  metadata rather than the agent. */
export function firstParagraph(text: string): string {
	const lines = String(text).replace(/\r\n/g, '\n').split('\n');
	const para: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('>')) {
			if (para.length) break; // the paragraph we were collecting just ended
			continue;               // still looking for one
		}
		para.push(line);
	}
	return plainCell(para.join(' '));
}

/** The tile summary for a role, in precedence order:
 *
 *  1. an optional `summary:` frontmatter override — opt-in, for the Missions that crop badly;
 *  2. the first paragraph of `## Mission`, which is the normal case. The Charter mandates the
 *     heading so it always exists, and it was written by whoever wrote the role — it cannot
 *     drift from the role, because it IS the role;
 *  3. the registry's one-line Mission, for a role file that predates the Charter and has no
 *     `## Mission` at all. Still not a second hand-maintained description: it is the same
 *     registry row the un-migrated stubs are built from;
 *  4. the file's opening paragraph, whatever it is.
 *
 *  A mandatory `summary:` field was the rejected alternative and stays rejected — two
 *  hand-maintained descriptions of one agent are guaranteed to disagree eventually. */
export function roleSummary(frontmatter: Record<string, string>, body: string, registryMission = ''): string {
	const override = (frontmatter.summary ?? '').trim();
	if (override) return plainCell(override);
	const mission = firstParagraph(sectionText(body, 'Mission'));
	if (mission) return mission;
	if (registryMission.trim()) return plainCell(registryMission);
	return firstParagraph(body);
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** Where a tile's declared fields came from. A `file` tile states what the role file declares
 *  about itself; a `registry` tile states what the registry PROPOSES for it, which Index.md is
 *  explicit is a classification read off behaviour and not a declaration by that agent. Keeping
 *  the two apart matters: an authority chip is a claim about blast radius, and rendering a
 *  proposed rung as if the agent had declared it is the false declaration check C3 exists for. */
export type RoleOrigin = 'file' | 'registry';

export interface RoleTile {
	slug: string;
	name: string;
	surface: string;
	authority: string;
	status: string;
	summary: string;
	/** Role-file name inside the library folder, or null for an un-migrated stub. */
	file: string | null;
	origin: RoleOrigin;
	/** True once a role file exists for this slug. False = un-migrated: a real agent whose
	 *  instructions live somewhere no person and no Custodian can see. */
	migrated: boolean;
	/** True when the file declares the Charter frontmatter (name + authority + status). The four
	 *  pre-Charter vault roles have a file but declare none of it. */
	charterFormat: boolean;
	/** False for a role file with no row in the registry — drift worth naming, not an error. */
	registered: boolean;
	revised: string;
	reviewed: string;
	/** Human phrasing of the Custodian-review state, including the Charter's staleness rule. */
	reviewLabel: string;
	/** Where the un-migrated role's instructions live today, as the registry describes it. */
	livesIn: string;
	/** Steps to migrate an un-migrated role. Empty for a migrated one. */
	migration: string[];
	/** Precomputed lowercase haystack: name, slug, mission and scope text. */
	search: string;
}

export interface Library {
	tiles: RoleTile[];
	/** "N of M roles have a role file" — says more about library health than any single tile. */
	coverage: { withFile: number; total: number };
	/** Slugs with a role file but no registry row. */
	unregistered: string[];
	/** Slugs claimed by more than one file (role-library.ts reports these; one file is dead). */
	duplicates: string[];
	registryFound: boolean;
}

const ordered = (list: string[], order: string[]): string[] => [
	...order.filter((o) => list.includes(o)),
	...list.filter((l) => !order.includes(l)).sort(),
];

/** Charter ladder order — ascending blast radius, which is the order these are compared in. */
export const AUTHORITY_ORDER = ['observer', 'proposer', 'operator', 'autonomous'];
export const STATUS_ORDER = ['active', 'proposed', 'retired'];

/** `custodian-reviewed:` against `revised:`, phrased for the tile. The Charter's C8 drift check
 *  is exactly this comparison, so the view can state it rather than making you compare two dates
 *  by eye. A non-date value (the Custodian's own `n/a — cannot review itself`) is passed through
 *  as written: it is a deliberate human answer, not a missing one. */
export function reviewLabel(reviewed: string, revised: string): string {
	const r = reviewed.trim();
	if (!r) return 'never reviewed';
	const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
	if (!isDate(r)) return r;
	if (isDate(revised.trim()) && r < revised.trim()) return `reviewed ${r} · stale (revised ${revised.trim()})`;
	return `reviewed ${r}`;
}

/** Where an un-migrated role's instructions live today, read out of its registry Status cell
 *  rather than out of a table in this file. The registry is where that fact is maintained; a
 *  copy here would be one more thing to keep in sync with the vault, and would go stale the
 *  first time a file moved. */
export function livesIn(row: RegistryRow): string {
	const text = row.statusText;
	const inSource = /not migrated\s*\(?\s*([^)]+?)\s*\)?$/i.exec(text);
	if (inSource?.[1]) return inSource[1].trim();
	const inConfig = /lives in (.+)$/i.exec(text);
	if (inConfig?.[1]) return inConfig[1].trim();
	if (/not (yet )?built/i.test(text)) return 'nothing yet — the surface it would run on is unbuilt';
	return '';
}

/** The steps to migrate one un-migrated role into a role file. The SHAPE is fixed and comes from
 *  the Charter; the specifics differ per role because the source location and the surface differ,
 *  so they are derived from that role's registry row. Rendering these next to the gap is the
 *  point — a migration recorded somewhere else is a migration that does not happen. */
export function migrationSteps(row: RegistryRow): string[] {
	const file = `_meta/agents/${row.name}.md`;
	const where = livesIn(row);
	const charterFile = (status: string): string =>
		`Write \`${file}\` in Charter format — eight headings, \`role: ${row.slug}\`, \`status: ${status}\`.`;

	if (/not (yet )?built/i.test(row.statusText)) {
		return [
			charterFile('proposed'),
			'Build the surface against that file — the role file is the spec, not a description written afterwards.',
			`Have it read \`_meta/agents/\` through a role loader, keyed on \`role: ${row.slug}\`.`,
			'Flip `status: active` and update the registry row in Index.md once it runs.',
		];
	}
	if (/lives in/i.test(row.statusText)) {
		return [
			charterFile('active'),
			`Move the policy prose out of ${where || 'that config'} into it; leave the schedule and any credentials where they are — those are runtime facts, not policy.`,
			'Point the scheduled task at the role file, so the file is the copy that gets edited.',
			'Update the registry row in Index.md.',
		];
	}
	return [
		charterFile('active'),
		`Move the policy prose out of ${where ? `\`${where}\`` : 'the application source'}; leave runtime facts (paths, coord dir, schedules) in code.`,
		'Replace the literal with a loader call that falls back to the existing string on any failure.',
		`Point ${row.surface ? `${row.surface}'s` : "that app's"} role-library path at \`_meta/agents/\`.`,
		'Restart the session to pick it up.',
	];
}

const haystack = (parts: (string | undefined)[]): string => parts.filter(Boolean).join(' ').toLowerCase();

/** Build every tile from one parse of the library plus the registry. Registry rows are the spine
 *  — "every agent, on every surface" is what that table is for — and a role file with no row is
 *  still shown, tagged unregistered, because hiding it would hide real drift. */
export function buildLibrary(index: RoleIndex, registry: RegistryRow[]): Library {
	const tiles: RoleTile[] = [];
	const seen = new Set<string>();

	for (const row of registry) {
		seen.add(row.slug);
		const role = index.roles.get(row.slug);
		if (!role) {
			tiles.push({
				slug: row.slug,
				name: row.name,
				surface: row.surface,
				authority: row.authority,
				status: row.status,
				summary: row.mission,
				file: null,
				origin: 'registry',
				migrated: false,
				charterFormat: false,
				registered: true,
				revised: '',
				reviewed: '',
				reviewLabel: 'never reviewed — there is no file to review',
				livesIn: livesIn(row),
				migration: migrationSteps(row),
				search: haystack([row.name, row.slug, row.surface, row.mission, row.cadence, row.statusText]),
			});
			continue;
		}
		tiles.push(fileTile(role.slug, role.frontmatter, role.body, role.file, role.status, row));
	}

	const unregistered: string[] = [];
	for (const [slug, role] of index.roles) {
		if (seen.has(slug)) continue;
		unregistered.push(slug);
		tiles.push(fileTile(slug, role.frontmatter, role.body, role.file, role.status, null));
	}

	return {
		tiles,
		coverage: { withFile: tiles.filter((t) => t.migrated).length, total: tiles.length },
		unregistered,
		duplicates: index.duplicates,
		registryFound: registry.length > 0,
	};
}

/** A tile for a role that HAS a file. The file's own declarations win; the registry row fills in
 *  only what a pre-Charter file does not declare, and `origin` records which happened. */
function fileTile(slug: string, fm: Record<string, string>, body: string, file: string, status: string, row: RegistryRow | null): RoleTile {
	const declared = (k: string): string => (fm[k] ?? '').trim();
	const charterFormat = !!declared('name') && !!declared('authority') && !!declared('status');
	const revised = declared('revised');
	const reviewed = declared('custodian-reviewed');
	const scope = sectionText(body, 'Scope');
	const summary = roleSummary(fm, body, row?.mission ?? '');
	return {
		slug,
		name: declared('name') || row?.name || slug,
		surface: declared('surface') || row?.surface || '',
		authority: declared('authority').toLowerCase() || row?.authority || '',
		status: status || row?.status || '',
		summary,
		file,
		origin: charterFormat ? 'file' : 'registry',
		migrated: true,
		charterFormat,
		registered: row !== null,
		revised,
		reviewed,
		reviewLabel: reviewLabel(reviewed, revised),
		livesIn: '',
		migration: [],
		search: haystack([declared('name'), row?.name, slug, declared('surface'), summary, scope, row?.mission]),
	};
}

// ---------------------------------------------------------------------------------------------
// Filtering, searching, grouping — all pure view state, nothing persisted
// ---------------------------------------------------------------------------------------------

export interface RoleFilters {
	/** Empty array = no constraint on that facet. Within a facet the values OR; facets AND. */
	surfaces: string[];
	authorities: string[];
	statuses: string[];
	/** Un-migrated roles are their own filter condition, OFF by default: they are real agents and
	 *  belong in the library, but they are not the normal case, and a default view that opened as
	 *  a to-do list would be read as one. */
	showUnmigrated: boolean;
	search: string;
}

export const EMPTY_FILTERS: RoleFilters = { surfaces: [], authorities: [], statuses: [], showUnmigrated: false, search: '' };

/** Add or remove one value from a facet — the filter chips' only state transition. */
export function toggleFacet(list: string[], value: string): string[] {
	return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Every token must appear somewhere in the tile's haystack (name, slug, surface, mission and
 *  scope text). AND across tokens, because narrowing is what a second word is for. */
export function matchesSearch(tile: RoleTile, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	return tokens.every((t) => tile.search.includes(t));
}

export function filterTiles(tiles: RoleTile[], f: RoleFilters): RoleTile[] {
	return tiles.filter((t) => {
		if (!t.migrated && !f.showUnmigrated) return false;
		if (f.surfaces.length && !f.surfaces.includes(t.surface)) return false;
		if (f.authorities.length && !f.authorities.includes(t.authority)) return false;
		if (f.statuses.length && !f.statuses.includes(t.status)) return false;
		return matchesSearch(t, f.search);
	});
}

export function isFiltered(f: RoleFilters): boolean {
	return f.surfaces.length > 0 || f.authorities.length > 0 || f.statuses.length > 0 || f.search.trim() !== '';
}

/** The facet values actually present, so the chip row describes THIS library rather than an
 *  invented taxonomy. Authority and status keep their Charter order; surfaces sort by name. */
export function facets(tiles: RoleTile[]): { surfaces: string[]; authorities: string[]; statuses: string[] } {
	const uniq = (vals: string[]): string[] => [...new Set(vals.filter((v) => v !== ''))];
	return {
		surfaces: uniq(tiles.map((t) => t.surface)).sort(),
		authorities: ordered(uniq(tiles.map((t) => t.authority)), AUTHORITY_ORDER),
		statuses: ordered(uniq(tiles.map((t) => t.status)), STATUS_ORDER),
	};
}

/** Group by surface — how these are actually thought about. Groups are ordered by size then
 *  name, and roles within a group by name, so the wall of tiles is stable between renders. */
export function groupBySurface(tiles: RoleTile[]): { surface: string; tiles: RoleTile[] }[] {
	const groups = new Map<string, RoleTile[]>();
	for (const t of tiles) {
		const key = t.surface || '(no surface declared)';
		const list = groups.get(key) ?? [];
		list.push(t);
		groups.set(key, list);
	}
	return [...groups.entries()]
		.map(([surface, list]) => ({ surface, tiles: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
		.sort((a, b) => b.tiles.length - a.tiles.length || a.surface.localeCompare(b.surface));
}

// ---------------------------------------------------------------------------------------------
// Opening the file
// ---------------------------------------------------------------------------------------------

/** Slashes both ways, because these paths come off Windows and go into a URI. */
const norm = (p: string): string => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/** Every directory above a file, nearest first: the walk that looks for a `.obsidian/` folder.
 *  Cheap, needs no configuration, and hands back the vault name free from the folder name. */
export function ancestorDirs(filePath: string): string[] {
	const parts = norm(filePath).split('/');
	parts.pop(); // the file itself
	const dirs: string[] = [];
	while (parts.length) {
		dirs.push(parts.length === 1 ? `${parts[0]}/` : parts.join('/'));
		parts.pop();
	}
	return dirs;
}

/** A path relative to the vault root, forward-slashed. Case-insensitive prefix match: the vault
 *  is on Windows, where the same folder is spelled several ways. Falls back to the file name,
 *  which Obsidian also resolves, if the file is somehow not under the root. */
export function vaultRelative(vaultRoot: string, filePath: string): string {
	const root = norm(vaultRoot);
	const file = norm(filePath);
	if (file.toLowerCase().startsWith(root.toLowerCase() + '/')) return file.slice(root.length + 1);
	return file.split('/').pop() ?? file;
}

export type OpenTarget =
	| { kind: 'obsidian'; uri: string; vault: string; file: string }
	| { kind: 'path'; path: string };

/** Where a tile's link should send you. Obsidian is the primary target because it is where these
 *  files are read, edited and linked — sending someone to Notepad while Obsidian is open on the
 *  next monitor is the wrong default. With no vault above the file, the OS default app is right.
 *  (The caller falls back to the same `path` target if the URI finds no handler.) */
export function resolveOpenTarget(filePath: string, vaultRoot: string | null): OpenTarget {
	if (!vaultRoot) return { kind: 'path', path: filePath };
	const vault = norm(vaultRoot).split('/').pop() ?? '';
	if (!vault) return { kind: 'path', path: filePath };
	const file = vaultRelative(vaultRoot, filePath);
	return {
		kind: 'obsidian',
		vault,
		file,
		uri: `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`,
	};
}
