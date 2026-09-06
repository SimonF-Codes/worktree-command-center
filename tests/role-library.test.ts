import { describe, it, expect } from 'vitest';
import {
	parseRoleFile, indexRoles, pickRole, renderFacts, buildPrompt, parseRoleLibrary, isRoleDocument,
} from '../src/terminals/role-library';

const alpha = [
	'---',
	'type: reference',
	'role: alpha',
	'name: Alpha',
	'status: active',
	'custodian-reviewed:',
	'---',
	'',
	'## Mission',
	'',
	'The overseer of the floor.',
	'',
].join('\n');

describe('parseRoleFile', () => {
	it('splits frontmatter from the body', () => {
		const r = parseRoleFile(alpha)!;
		expect(r.frontmatter.role).toBe('alpha');
		expect(r.frontmatter.status).toBe('active');
		expect(r.frontmatter['custodian-reviewed']).toBe(''); // a blank field is present, not missing
		expect(r.body).toBe('## Mission\n\nThe overseer of the floor.');
	});

	it('tolerates a BOM and CRLF line endings (OneDrive/Obsidian both produce them)', () => {
		const r = parseRoleFile('\uFEFF' + alpha.replace(/\n/g, '\r\n'))!;
		expect(r.frontmatter.role).toBe('alpha');
		expect(r.body).toBe('## Mission\n\nThe overseer of the floor.');
	});

	it('strips a trailing " # comment" so a file copied from the Charter template still indexes', () => {
		const r = parseRoleFile('---\nrole: alpha    # stable slug, never change it\n---\nbody\n')!;
		expect(r.frontmatter.role).toBe('alpha');
	});

	it('keeps a hash that is part of the value', () => {
		const r = parseRoleFile('---\nname: C#-agent\n---\nbody\n')!;
		expect(r.frontmatter.name).toBe('C#-agent');
	});

	it('keeps colons inside a value', () => {
		const r = parseRoleFile('---\npath: C:/vault/_meta\n---\nbody\n')!;
		expect(r.frontmatter.path).toBe('C:/vault/_meta');
	});

	it('returns null (never throws) for a file that is not a role file', () => {
		expect(parseRoleFile('# Just a note\n\ntext')).toBeNull();
		expect(parseRoleFile('')).toBeNull();
		expect(parseRoleFile('---\nrole: alpha\nno closing fence')).toBeNull();
	});
});

describe('indexRoles', () => {
	const files = [
		{ name: 'Alpha.md', text: alpha },
		{ name: 'Notes.md', text: '# not a role file' },
		{ name: 'Worker.md', text: '---\nrole: worker-terminal\nstatus: proposed\n---\nworker body' },
	];

	it('keys on the role slug, not the filename', () => {
		const idx = indexRoles(files);
		expect([...idx.roles.keys()].sort()).toEqual(['alpha', 'worker-terminal']);
		expect(idx.roles.get('alpha')!.file).toBe('Alpha.md');
		expect(idx.roles.get('worker-terminal')!.status).toBe('proposed');
	});

	it('skips files with no fence and files with no role: field', () => {
		const idx = indexRoles([{ name: 'x.md', text: '---\ntype: reference\n---\nbody' }, ...files]);
		expect(idx.roles.size).toBe(2);
	});

	it('carries the whole frontmatter through, for readers that need the display fields', () => {
		const idx = indexRoles(files);
		expect(idx.roles.get('alpha')!.frontmatter.name).toBe('Alpha');
		expect(idx.roles.get('alpha')!.frontmatter['custodian-reviewed']).toBe('');
	});

	it('reports a duplicate slug and lets the last file win', () => {
		const idx = indexRoles([
			{ name: 'Old.md', text: '---\nrole: alpha\nstatus: active\n---\nold' },
			{ name: 'New.md', text: '---\nrole: alpha\nstatus: active\n---\nnew' },
		]);
		expect(idx.duplicates).toEqual(['alpha']);
		expect(idx.roles.get('alpha')!.body).toBe('new');
	});
});

describe('isRoleDocument', () => {
	it('excludes the documents ABOUT the library — Custodian Procedure step 2', () => {
		expect(isRoleDocument('Index.md')).toBe(false);
		expect(isRoleDocument('Charter.md')).toBe(false);
		expect(isRoleDocument('Summary.md')).toBe(false);
		expect(isRoleDocument('Custodian Reports/2026-09-05 Custodian Review.md')).toBe(false);
	});

	it('is case- and separator-insensitive (OneDrive on Windows preserves neither)', () => {
		expect(isRoleDocument('charter.md')).toBe(false);
		expect(isRoleDocument('CUSTODIAN REPORTS\\2026-09-05.md')).toBe(false);
		expect(isRoleDocument('./Summary.MD')).toBe(false);
	});

	it('keeps every actual role file, including ones whose name contains an excluded word', () => {
		expect(isRoleDocument('Alpha.md')).toBe(true);
		expect(isRoleDocument('Agent Custodian.md')).toBe(true);
		expect(isRoleDocument('Worker Terminal.md')).toBe(true);
	});
});

describe('pickRole', () => {
	const idx = indexRoles([
		{ name: 'Alpha.md', text: alpha },
		{ name: 'Worker.md', text: '---\nrole: worker-terminal\nstatus: proposed\n---\nworker body' },
		{ name: 'Folder.md', text: '---\nrole: folder-terminal\nstatus: active\n---\n' },
		{ name: 'Sorter.md', text: '---\nrole: sorter\n---\nsorter body' },
	]);

	it('returns an active role', () => {
		const r = pickRole(idx, 'alpha');
		expect(r.ok).toBe(true);
		expect(r.ok && r.role.body).toContain('The overseer of the floor.');
	});

	it('refuses a role that is not active, and says which status it saw', () => {
		const r = pickRole(idx, 'worker-terminal');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toContain('proposed');
	});

	it('treats a missing status as not active', () => {
		const r = pickRole(idx, 'sorter');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toContain('(unset)');
	});

	it('refuses an empty body — facts alone are worse than the built-in prompt', () => {
		const r = pickRole(idx, 'folder-terminal');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toContain('empty body');
	});

	it('reports an unknown slug by name', () => {
		const r = pickRole(idx, 'butler');
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toContain('butler');
	});
});

describe('renderFacts', () => {
	it('renders one bullet per fact', () => {
		expect(renderFacts([
			{ label: 'repo', value: 'worktree-command-center' },
			{ label: 'branch', value: 'wt/main-4' },
		])).toBe('## Session facts\n\n- repo: worktree-command-center\n- branch: wt/main-4\n');
	});

	it('indents a multi-line value as a sub-list', () => {
		expect(renderFacts([{ label: 'targets', value: 'app → /repos/app\nnotes → /notes' }]))
			.toBe('## Session facts\n\n- targets:\n  app → /repos/app\n  notes → /notes\n');
	});

	it('drops empty values rather than emitting a dangling label', () => {
		expect(renderFacts([{ label: 'branch', value: '' }, { label: 'repo', value: 'x' }]))
			.toBe('## Session facts\n\n- repo: x\n');
	});
});

describe('buildPrompt', () => {
	it('is the role body, a rule, then the session facts', () => {
		const role = { slug: 'alpha', status: 'active', body: '\nBody text.\n\n', file: 'Alpha.md', frontmatter: {} };
		expect(buildPrompt(role, [{ label: 'repo', value: 'app' }]))
			.toBe('Body text.\n\n---\n\n## Session facts\n\n- repo: app\n');
	});
});

describe('parseRoleLibrary', () => {
	it('accepts a path', () => {
		expect(parseRoleLibrary({ path: 'C:/vault/_meta/agents' })).toEqual({ path: 'C:/vault/_meta/agents' });
	});
	it('returns undefined for anything else — an absent key means built-ins, not an error', () => {
		expect(parseRoleLibrary(undefined)).toBeUndefined();
		expect(parseRoleLibrary(null)).toBeUndefined();
		expect(parseRoleLibrary('C:/vault')).toBeUndefined();
		expect(parseRoleLibrary({})).toBeUndefined();
		expect(parseRoleLibrary({ path: '   ' })).toBeUndefined();
	});
});
