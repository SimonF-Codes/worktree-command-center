import { describe, it, expect } from 'vitest';
import {
	checkDelegation, checkDelegationBySlug, delegationRoleOf, isManager, lookupFrom, parseManagersEnabled,
	parseSpawns, rungIndex, RUNGS, type DelegationRole,
} from '../src/core/delegation';
import { parseRoleFile } from '../src/terminals/role-library';

const role = (slug: string, authority: string, spawns: string[] = []): DelegationRole => ({ slug, authority, spawns });
const lead = role('team-lead', 'operator', ['worker-terminal', 'researcher']);
const worker = role('worker-terminal', 'operator');
const researcher = role('researcher', 'proposer');

describe('rungIndex', () => {
	it('orders the four rungs and nothing else', () => {
		expect(RUNGS.map(rungIndex)).toEqual([0, 1, 2, 3]);
		expect(rungIndex(' Operator ')).toBe(2);
		for (const bad of ['', undefined, 'god', 'admin', 'operator, autonomous']) expect(rungIndex(bad)).toBe(-1);
	});
});

describe('parseSpawns', () => {
	it('reads the inline list, a bare comma list, quotes and case', () => {
		expect(parseSpawns('[worker-terminal, researcher]')).toEqual(['worker-terminal', 'researcher']);
		expect(parseSpawns('worker-terminal, researcher')).toEqual(['worker-terminal', 'researcher']);
		expect(parseSpawns(`["Worker-Terminal", 'researcher', worker-terminal]`)).toEqual(['worker-terminal', 'researcher']);
	});
	it('absent, empty and [] all mean "starts nothing"', () => {
		for (const v of [undefined, '', '   ', '[]', '[ ]', ',']) expect(parseSpawns(v)).toEqual([]);
	});
});

describe('checkDelegation — the Charter\'s three conditions', () => {
	it('allows a listed child at or below the parent\'s rung whose own spawns are a subset', () => {
		expect(checkDelegation(lead, worker)).toEqual({ ok: true });
		expect(checkDelegation(lead, researcher)).toEqual({ ok: true });
		expect(checkDelegation(lead, role('researcher', 'observer', ['researcher']))).toEqual({ ok: true });
	});

	it('1 — refuses a child not in spawns:, naming the condition and the list', () => {
		const r = checkDelegation(lead, role('alpha', 'operator'));
		expect(r).toMatchObject({ ok: false, condition: 'listed' });
		if (!r.ok) expect(r.reason).toBe("team-lead may not spawn alpha — condition 1 of 3 (listed): alpha is not in team-lead's spawns: (worker-terminal, researcher)");
	});

	it('1 — a role with no spawns: starts nothing at all', () => {
		const r = checkDelegation(worker, worker);
		expect(r).toMatchObject({ ok: false, condition: 'listed' });
		if (!r.ok) expect(r.reason).toContain('has no spawns:, so it starts nothing');
	});

	it('2 — refuses a child above the parent\'s rung', () => {
		const r = checkDelegation(role('team-lead', 'proposer', ['worker-terminal']), worker);
		expect(r).toMatchObject({ ok: false, condition: 'rung' });
		if (!r.ok) expect(r.reason).toContain('worker-terminal is operator, above team-lead\'s proposer');
	});

	it('2 — an authority that is not a rung fails closed, on either side', () => {
		const a = checkDelegation(role('team-lead', 'god', ['worker-terminal']), worker);
		const b = checkDelegation(lead, role('worker-terminal', ''));
		expect(a).toMatchObject({ ok: false, condition: 'rung' });
		expect(b).toMatchObject({ ok: false, condition: 'rung' });
		if (!a.ok) expect(a.reason).toContain('team-lead\'s authority: is "god"');
		if (!b.ok) expect(b.reason).toContain('worker-terminal\'s authority: is "(unset)"');
	});

	it('3 — refuses a child whose spawns: would widen the parent\'s', () => {
		const r = checkDelegation(lead, role('researcher', 'proposer', ['researcher', 'alpha']));
		expect(r).toMatchObject({ ok: false, condition: 'subset' });
		if (!r.ok) expect(r.reason).toContain("researcher's spawns: would widen team-lead's by alpha");
	});

	it('checks the conditions in order: the first failure is the one reported', () => {
		// fails 2 and 3 as well, but 1 is reported
		expect(checkDelegation(role('p', 'observer', ['x']), role('y', 'autonomous', ['z']))).toMatchObject({ condition: 'listed' });
		// fails 3 as well, but 2 is reported
		expect(checkDelegation(role('p', 'observer', ['x']), role('x', 'operator', ['z']))).toMatchObject({ condition: 'rung' });
	});
});

describe('checkDelegationBySlug', () => {
	const lookup = lookupFrom([lead, worker, researcher]);
	it('delegates to checkDelegation for known roles', () => {
		expect(checkDelegationBySlug(lookup, 'team-lead', 'researcher')).toEqual({ ok: true });
		expect(checkDelegationBySlug(lookup, 'worker-terminal', 'researcher')).toMatchObject({ ok: false, condition: 'listed' });
	});
	it('fails closed when either role has no active file, and names which', () => {
		const a = checkDelegationBySlug(lookup, 'ghost', 'worker-terminal');
		const b = checkDelegationBySlug(lookup, 'team-lead', 'ghost');
		expect(a).toMatchObject({ ok: false, condition: 'role-file' });
		expect(b).toMatchObject({ ok: false, condition: 'role-file' });
		if (!a.ok) expect(a.reason).toContain('declares role: ghost');
		if (!b.ok) expect(b.reason).toContain('declares role: ghost');
	});
});

describe('isManager — authority, not shape', () => {
	it('is true exactly when spawns: is non-empty', () => {
		expect(isManager(lead)).toBe(true);
		expect(isManager(worker)).toBe(false);
		expect(isManager(undefined)).toBe(false);
	});
});

describe('v2.managers', () => {
	it('is off unless explicitly true', () => {
		for (const v of [undefined, null, {}, { managers: 'true' }, { managers: 1 }, { managers: false }]) expect(parseManagersEnabled(v)).toBe(false);
		expect(parseManagersEnabled({ managers: true })).toBe(true);
	});
});

describe('spawns: from a role file', () => {
	const file = (fm: string): DelegationRole => {
		const p = parseRoleFile(`---\nrole: team-lead\nauthority: operator\n${fm}\nstatus: active\n---\nbody`)!;
		return delegationRoleOf('team-lead', p.frontmatter);
	};
	it('reads the Charter\'s inline form', () => {
		expect(file('spawns: [worker-terminal, researcher]').spawns).toEqual(['worker-terminal', 'researcher']);
	});
	it('reads a YAML block list, comments and all', () => {
		expect(file('spawns:            # the slugs it may start\n  - worker-terminal\n  # a note\n  - researcher   # read-only').spawns)
			.toEqual(['worker-terminal', 'researcher']);
	});
	it('an empty spawns: followed by another key is empty — the next key is not swallowed', () => {
		const p = parseRoleFile('---\nrole: x\nspawns:\nstatus: active\n---\nb')!;
		expect(p.frontmatter.spawns).toBe('');
		expect(p.frontmatter.status).toBe('active');
	});
	it('the Charter\'s own template block parses to "starts nothing"', () => {
		// The commented `spawns:` in the Charter's format block — exactly how a role copied from it starts.
		const tpl = '---\nrole: x\nmutable-by:                      # optional.\n                                 #   Omit for a normal role.\nspawns:                          # optional. The role slugs\n                                 #   list. Omit it\ncreated: 2026-09-04\n---\nb';
		const p = parseRoleFile(tpl)!;
		expect(parseSpawns(p.frontmatter.spawns)).toEqual([]);
		expect(p.frontmatter['mutable-by']).toBe('');
		expect(p.frontmatter.created).toBe('2026-09-04');
	});
});
