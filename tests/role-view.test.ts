import { describe, it, expect } from 'vitest';
import { indexRoles } from '../src/terminals/role-library';
import {
	parseRegistry, slugifyRoleName, plainCell, sectionText, firstParagraph, roleSummary,
	buildLibrary, reviewLabel, livesIn, migrationSteps, filterTiles, matchesSearch, facets,
	groupBySurface, toggleFacet, isFiltered, ancestorDirs, vaultRelative, resolveOpenTarget,
	EMPTY_FILTERS, type RegistryRow,
} from '../src/terminals/role-view';

// A trimmed copy of the vault's Index.md — same heading, same columns, same cell spellings.
const INDEX_MD = [
	'---',
	'type: reference',
	'role: index',
	'---',
	'',
	'## How agents use this vault',
	'',
	'Prose that is not a table.',
	'',
	'## Agent registry',
	'',
	'Every agent, on every surface.',
	'',
	'| Role | Surface | Authority | Mission | Cadence | Status |',
	'|---|---|---|---|---|---|',
	'| [[Alpha]] | worktree-command-center | operator | Overseer of the floor | on request | **active — Charter format** |',
	'| [[Sorter]] | vault | operator | Triage notes landing outside the structure | on new file | proposed — pre-Charter format |',
	'| eod-notes | cowork | autonomous | Write the EOD note from Slack + Drive | 3x/workday | active — lives in Cowork config |',
	'| butler | brain-2.0 | proposer | Calm ADD-aware assistant over the vault | on request, in chat | active — **not migrated** (`src/butler/session.ts`) |',
	'| design-assistant | brain-2.0 | operator | Review the design documents Alpha writes | on request | **proposed — not yet built** |',
	'',
	'## Migration status',
	'',
	'More prose.',
].join('\n');

const ALPHA_MD = [
	'---',
	'type: reference',
	'role: alpha',
	'name: Alpha',
	'surface: worktree-command-center',
	'authority: operator',
	'status: active',
	'created: 2026-09-04',
	'revised: 2026-09-05',
	'custodian-reviewed: 2026-09-05',
	'---',
	'',
	'## Mission',
	'',
	'The overseer of the floor, and through it the general interface to Simon\'s code and files.',
	'A single session consulted on demand.',
	'',
	'Second paragraph, which the tile must not show.',
	'',
	'## Scope',
	'',
	'**May touch:** every repo on the floor.',
	'',
	'## Guardrails',
	'',
	'1. A rule.',
].join('\n');

// Pre-Charter: a role file with a `role:` slug and nothing else the Charter asks for.
const SORTER_MD = [
	'---',
	'type: reference',
	'role: sorter',
	'created: 2026-08-18',
	'---',
	'',
	'## Mission',
	'',
	'Catch notes that land outside the Project → Component → Task → Daily structure.',
	'',
	'## Scope',
	'',
	'**May touch:** any note found outside its expected folder.',
].join('\n');

const registry = parseRegistry(INDEX_MD);
const library = buildLibrary(indexRoles([{ name: 'Alpha.md', text: ALPHA_MD }, { name: 'Sorter.md', text: SORTER_MD }]), registry);
const tile = (slug: string) => library.tiles.find((t) => t.slug === slug)!;

describe('parseRegistry', () => {
	it('reads every row of the Agent registry table', () => {
		expect(registry.map((r) => r.slug)).toEqual(['alpha', 'sorter', 'eod-notes', 'butler', 'design-assistant']);
	});

	it('strips wikilinks and bold, and keeps the Status cell as written', () => {
		expect(registry[0]!.name).toBe('Alpha');
		expect(registry[0]!.status).toBe('active');
		expect(registry[0]!.statusText).toBe('active — Charter format');
		expect(registry[3]!.statusText).toBe('active — not migrated (src/butler/session.ts)');
	});

	it('matches columns by header name, not position', () => {
		const moved = INDEX_MD
			.replace('| Role | Surface | Authority | Mission | Cadence | Status |', '| Role | Status | Surface | Authority | Mission | Cadence |')
			.replace('| [[Alpha]] | worktree-command-center | operator | Overseer of the floor | on request | **active — Charter format** |',
				'| [[Alpha]] | **active — Charter format** | worktree-command-center | operator | Overseer of the floor | on request |');
		const rows = parseRegistry(moved);
		expect(rows[0]!.surface).toBe('worktree-command-center');
		expect(rows[0]!.status).toBe('active');
	});

	it('degrades to [] rather than throwing when Index.md is missing or has no registry', () => {
		expect(parseRegistry(null)).toEqual([]);
		expect(parseRegistry('')).toEqual([]);
		expect(parseRegistry('# Notes\n\nno table here')).toEqual([]);
		expect(parseRegistry('## Agent registry\n\n## Something else\n\n| Role |\n|---|\n| x |')).toEqual([]);
	});

	it('stops at the end of the table', () => {
		expect(parseRegistry(INDEX_MD + '\n| stray | row |')).toHaveLength(5);
	});
});

describe('slugifyRoleName / plainCell', () => {
	it('slugifies a registry name into the file\'s role: slug', () => {
		expect(slugifyRoleName('[[Agent Custodian]]')).toBe('agent-custodian');
		expect(slugifyRoleName('morning brief')).toBe('morning-brief');
		expect(slugifyRoleName('**Worker Terminal**')).toBe('worker-terminal');
	});

	it('keeps the display half of a piped wikilink', () => {
		expect(plainCell('[[Personal/Code/Code Index|Code Index]]')).toBe('Code Index');
	});
});

describe('summary extraction', () => {
	it('is the FIRST paragraph of ## Mission, not the whole section', () => {
		expect(tile('alpha').summary).toBe(
			"The overseer of the floor, and through it the general interface to Simon's code and files. A single session consulted on demand.");
	});

	it('prefers an optional summary: override for a Mission that crops badly', () => {
		const fm = { summary: 'A short hand-written line.' };
		expect(roleSummary(fm, '## Mission\n\nA very long opening sentence.')).toBe('A short hand-written line.');
	});

	it('skips a callout so the summary describes the agent, not the file', () => {
		const body = '## Mission\n\n> [!important]\n> This file is not modifiable by the agents it governs.\n\nKeep the library sane.';
		expect(roleSummary({}, body)).toBe('Keep the library sane.');
	});

	it('falls back to the registry mission when a pre-Charter file has no Mission heading', () => {
		expect(roleSummary({}, '## Purpose\n\nsomething', 'Triage notes')).toBe('Triage notes');
	});

	it('falls back to the opening paragraph when there is nothing else', () => {
		expect(roleSummary({}, 'Just prose.\n\nMore.')).toBe('Just prose.');
		expect(roleSummary({}, '')).toBe('');
	});

	it('sectionText stops at the next heading of any level', () => {
		expect(sectionText(ALPHA_MD, 'Scope')).toBe('**May touch:** every repo on the floor.');
		expect(sectionText(ALPHA_MD, 'Nonexistent')).toBe('');
	});

	it('firstParagraph joins wrapped lines into one', () => {
		expect(firstParagraph('one\ntwo\n\nthree')).toBe('one two');
	});
});

describe('buildLibrary', () => {
	it('makes one tile per registry row, plus any unregistered role file', () => {
		expect(library.tiles.map((t) => t.slug)).toEqual(['alpha', 'sorter', 'eod-notes', 'butler', 'design-assistant']);
		expect(library.unregistered).toEqual([]);
		expect(library.registryFound).toBe(true);
	});

	it('counts coverage across the whole library', () => {
		expect(library.coverage).toEqual({ withFile: 2, total: 5 });
	});

	it('lets the role file win over the registry, and records that the file declared it', () => {
		expect(tile('alpha').origin).toBe('file');
		expect(tile('alpha').charterFormat).toBe(true);
		expect(tile('alpha').authority).toBe('operator');
		expect(tile('alpha').file).toBe('Alpha.md');
		expect(tile('alpha').reviewLabel).toBe('reviewed 2026-09-05');
	});

	it('fills a pre-Charter file\'s undeclared fields from the registry, and says so', () => {
		const t = tile('sorter');
		expect(t.migrated).toBe(true);
		expect(t.charterFormat).toBe(false);
		expect(t.origin).toBe('registry');   // the rung is the registry's proposal, not a declaration
		expect(t.authority).toBe('operator');
		expect(t.surface).toBe('vault');
		expect(t.status).toBe('proposed');
		expect(t.reviewLabel).toBe('never reviewed');
	});

	it('renders a registry row with no file as an un-migrated stub carrying its migration steps', () => {
		const t = tile('butler');
		expect(t.migrated).toBe(false);
		expect(t.file).toBeNull();
		expect(t.summary).toBe('Calm ADD-aware assistant over the vault');
		expect(t.livesIn).toBe('src/butler/session.ts');
		expect(t.migration[0]).toContain('_meta/agents/butler.md');
		expect(t.migration.some((s) => s.includes('src/butler/session.ts'))).toBe(true);
	});

	it('keeps a role file with no registry row, tagged unregistered — that is drift, not nothing', () => {
		const extra = '---\nrole: ghost\nname: Ghost\nsurface: vault\nauthority: observer\nstatus: active\n---\n\n## Mission\n\nWatches.';
		const lib = buildLibrary(indexRoles([{ name: 'Ghost.md', text: extra }]), registry);
		expect(lib.unregistered).toEqual(['ghost']);
		expect(lib.tiles.find((t) => t.slug === 'ghost')!.registered).toBe(false);
		expect(lib.coverage).toEqual({ withFile: 1, total: 6 });
	});

	it('works with no registry at all — the role files alone still render', () => {
		const lib = buildLibrary(indexRoles([{ name: 'Alpha.md', text: ALPHA_MD }]), []);
		expect(lib.registryFound).toBe(false);
		expect(lib.tiles.map((t) => t.slug)).toEqual(['alpha']);
		expect(lib.coverage).toEqual({ withFile: 1, total: 1 });
	});

	it('carries the duplicate slugs role-library reports', () => {
		const dup = '---\nrole: alpha\nname: Alpha II\nstatus: active\n---\n\n## Mission\n\nOther.';
		const lib = buildLibrary(indexRoles([{ name: 'A.md', text: ALPHA_MD }, { name: 'B.md', text: dup }]), registry);
		expect(lib.duplicates).toEqual(['alpha']);
	});
});

describe('reviewLabel', () => {
	it('names a review, a missing one, and a stale one (the Charter\'s C8 drift check)', () => {
		expect(reviewLabel('2026-09-05', '2026-09-05')).toBe('reviewed 2026-09-05');
		expect(reviewLabel('', '2026-09-05')).toBe('never reviewed');
		expect(reviewLabel('2026-09-01', '2026-09-05')).toBe('reviewed 2026-09-01 · stale (revised 2026-09-05)');
	});

	it('passes a deliberate non-date answer through as written', () => {
		expect(reviewLabel('n/a — cannot review itself', '2026-09-05')).toBe('n/a — cannot review itself');
	});
});

describe('migration instructions', () => {
	const row = (statusText: string, over: Partial<RegistryRow> = {}): RegistryRow => ({
		slug: 'butler', name: 'Butler', surface: 'brain-2.0', authority: 'proposer',
		mission: 'm', cadence: 'c', statusText, status: 'active', ...over,
	});

	it('reads the source location out of the registry row rather than a table in the app', () => {
		expect(livesIn(row('active — not migrated (`src/butler/session.ts`)'.replace(/`/g, '')))).toBe('src/butler/session.ts');
		expect(livesIn(row('active — lives in Cowork config'))).toBe('Cowork config');
		expect(livesIn(row('proposed — not yet built'))).toContain('unbuilt');
		expect(livesIn(row('active — Charter format'))).toBe('');
	});

	it('gives a source-literal role the loader-with-fallback steps', () => {
		const steps = migrationSteps(row('active — not migrated (src/butler/session.ts)'));
		expect(steps[0]).toContain('`role: butler`');
		expect(steps.join(' ')).toContain('falls back to the existing string');
		expect(steps.join(' ')).toContain("brain-2.0's");
	});

	it('gives a config-defined role steps that leave its schedule where it is', () => {
		const steps = migrationSteps(row('active — lives in Cowork config', { slug: 'eod-notes', name: 'eod-notes', surface: 'cowork' }));
		expect(steps.join(' ')).toContain('Cowork config');
		expect(steps.join(' ')).toContain('runtime facts, not policy');
	});

	it('tells an unbuilt role to write the file first, as the spec', () => {
		const steps = migrationSteps(row('proposed — not yet built', { slug: 'design-assistant', name: 'design-assistant' }));
		expect(steps[0]).toContain('`status: proposed`');
		expect(steps[1]).toContain('the role file is the spec');
	});
});

describe('filters', () => {
	it('hides un-migrated roles by default', () => {
		expect(filterTiles(library.tiles, EMPTY_FILTERS).map((t) => t.slug)).toEqual(['alpha', 'sorter']);
	});

	it('shows them when the un-migrated condition is on', () => {
		expect(filterTiles(library.tiles, { ...EMPTY_FILTERS, showUnmigrated: true })).toHaveLength(5);
	});

	it('composes: facets AND, values within a facet OR', () => {
		const f = { ...EMPTY_FILTERS, showUnmigrated: true, surfaces: ['brain-2.0', 'cowork'], authorities: ['proposer', 'autonomous'] };
		expect(filterTiles(library.tiles, f).map((t) => t.slug)).toEqual(['eod-notes', 'butler']);
	});

	it('intersects a facet with search', () => {
		const f = { ...EMPTY_FILTERS, showUnmigrated: true, statuses: ['active'], search: 'butler' };
		expect(filterTiles(library.tiles, f).map((t) => t.slug)).toEqual(['butler']);
	});

	it('searches name, slug, mission and scope text, with every token required', () => {
		expect(matchesSearch(tile('alpha'), 'overseer')).toBe(true);
		expect(matchesSearch(tile('alpha'), 'ALPHA')).toBe(true);
		expect(matchesSearch(tile('alpha'), 'every repo on the floor')).toBe(true); // ## Scope text
		expect(matchesSearch(tile('alpha'), 'overseer nonsense')).toBe(false);
		expect(matchesSearch(tile('alpha'), '   ')).toBe(true); // empty query matches everything
	});

	it('toggleFacet adds then removes, and isFiltered ignores the un-migrated condition', () => {
		expect(toggleFacet([], 'vault')).toEqual(['vault']);
		expect(toggleFacet(['vault', 'cowork'], 'vault')).toEqual(['cowork']);
		expect(isFiltered(EMPTY_FILTERS)).toBe(false);
		expect(isFiltered({ ...EMPTY_FILTERS, showUnmigrated: true })).toBe(false);
		expect(isFiltered({ ...EMPTY_FILTERS, search: 'x' })).toBe(true);
	});
});

describe('facets and grouping', () => {
	it('offers only the values this library actually has, rungs in Charter order', () => {
		const f = facets(library.tiles);
		expect(f.surfaces).toEqual(['brain-2.0', 'cowork', 'vault', 'worktree-command-center']);
		expect(f.authorities).toEqual(['proposer', 'operator', 'autonomous']);
		expect(f.statuses).toEqual(['active', 'proposed']);
	});

	it('groups by surface, biggest group first, roles by name inside it', () => {
		const groups = groupBySurface(library.tiles);
		expect(groups[0]!.surface).toBe('brain-2.0');
		expect(groups[0]!.tiles.map((t) => t.name)).toEqual(['butler', 'design-assistant']);
		expect(groups.map((g) => g.surface)).toContain('worktree-command-center');
	});

	it('labels a role that declares no surface rather than dropping it', () => {
		const lib = buildLibrary(indexRoles([{ name: 'X.md', text: '---\nrole: x\nstatus: active\n---\n\n## Mission\n\nDoes a thing.' }]), []);
		expect(groupBySurface(lib.tiles)[0]!.surface).toBe('(no surface declared)');
	});
});

describe('opening the file', () => {
	it('walks up every ancestor directory, nearest first', () => {
		expect(ancestorDirs('C:/Users/s/Vault/_meta/agents/Alpha.md'))
			.toEqual(['C:/Users/s/Vault/_meta/agents', 'C:/Users/s/Vault/_meta', 'C:/Users/s/Vault', 'C:/Users/s', 'C:/Users', 'C:/']);
	});

	it('accepts Windows separators', () => {
		expect(ancestorDirs('C:\\vault\\_meta\\Alpha.md')).toEqual(['C:/vault/_meta', 'C:/vault', 'C:/']);
	});

	it('builds an obsidian:// URI from the vault folder name and the relative path', () => {
		const t = resolveOpenTarget('C:/Users/s/OneDrive/Simon-Brain/_meta/agents/Agent Custodian.md', 'C:/Users/s/OneDrive/Simon-Brain');
		expect(t.kind).toBe('obsidian');
		expect(t.kind === 'obsidian' && t.vault).toBe('Simon-Brain');
		expect(t.kind === 'obsidian' && t.file).toBe('_meta/agents/Agent Custodian.md');
		expect(t.kind === 'obsidian' && t.uri).toBe('obsidian://open?vault=Simon-Brain&file=_meta%2Fagents%2FAgent%20Custodian.md');
	});

	it('matches the vault prefix case-insensitively (the vault lives on Windows)', () => {
		expect(vaultRelative('C:/Users/S/Vault', 'c:/users/s/vault/_meta/Alpha.md')).toBe('_meta/Alpha.md');
	});

	it('falls back to the file name if the file is somehow not under the vault', () => {
		expect(vaultRelative('C:/other', 'C:/vault/Alpha.md')).toBe('Alpha.md');
	});

	it('opens with the OS default app when no vault was found above the file', () => {
		expect(resolveOpenTarget('D:/notes/Alpha.md', null)).toEqual({ kind: 'path', path: 'D:/notes/Alpha.md' });
	});
});
