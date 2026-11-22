import { describe, it, expect } from 'vitest';
import { buildSidebar, dotFor, parseSidebarEnabled, sidebarSignature, OVERSEER_ID, type SidebarSession, type SidebarWorkspaceInput } from '../src/ui/sidebar-model';

const s = (id: number, state: string, over: Partial<SidebarSession> = {}): SidebarSession =>
	({ id, name: `t${id}`, branch: `wt/${id}`, state, remoteOn: false, ...over });
const ws = (id: string, sessions: SidebarSession[], over: Partial<SidebarWorkspaceInput> = {}): SidebarWorkspaceInput =>
	({ id, name: id, active: false, live: true, sessions, ...over });

describe('parseSidebarEnabled', () => {
	it('is off unless v2.sidebar is exactly true', () => {
		expect(parseSidebarEnabled(undefined)).toBe(false);
		expect(parseSidebarEnabled(null)).toBe(false);
		expect(parseSidebarEnabled({})).toBe(false);
		expect(parseSidebarEnabled({ sidebar: 'yes' })).toBe(false);
		expect(parseSidebarEnabled({ sidebar: 1 })).toBe(false);
		expect(parseSidebarEnabled({ recordLineage: false })).toBe(false);
		expect(parseSidebarEnabled({ sidebar: true })).toBe(true);
	});
});

describe('dotFor', () => {
	it('maps the classifier states onto the four StateDot states', () => {
		expect(dotFor('prompt')).toBe('needs');
		expect(dotFor('menu')).toBe('needs');
		expect(dotFor('errored')).toBe('refused');
		expect(dotFor('running')).toBe('running');
		expect(dotFor('idle')).toBe('idle');
	});
	it('reads an unknown state as running, never as needing you', () => {
		expect(dotFor('???')).toBe('running');
	});
});

describe('buildSidebar — rows', () => {
	it('keeps every workspace, in the order given', () => {
		const g = buildSidebar([ws('b', []), ws('a', []), ws('c', [])], new Set());
		expect(g.map((x) => x.id)).toEqual(['b', 'a', 'c']);
	});

	it('orders sections Needs you → Running → Done and omits empty ones', () => {
		const g = buildSidebar([ws('w', [s(1, 'idle'), s(2, 'running'), s(3, 'prompt')])], new Set())[0]!;
		expect(g.sections.map((x) => x.bucket)).toEqual(['needs', 'running', 'done']);
		expect(g.sections.map((x) => x.rows.map((r) => r.id))).toEqual([[3], [2], [1]]);
		const only = buildSidebar([ws('w', [s(1, 'running')])], new Set())[0]!;
		expect(only.sections.map((x) => x.bucket)).toEqual(['running']);
	});

	it('puts errored sessions under Needs you, after prompts and menus, with a red dot', () => {
		const g = buildSidebar([ws('w', [s(1, 'errored'), s(2, 'menu'), s(3, 'prompt')])], new Set())[0]!;
		const needs = g.sections[0]!;
		expect(needs.bucket).toBe('needs');
		expect(needs.rows.map((r) => r.id)).toEqual([3, 2, 1]);
		expect(needs.rows.map((r) => r.dot)).toEqual(['needs', 'needs', 'refused']);
	});

	it('orders rows within a section by id, so a row does not jump around between ticks', () => {
		const g = buildSidebar([ws('w', [s(9, 'running'), s(4, 'running'), s(6, 'running')])], new Set())[0]!;
		expect(g.sections[0]!.rows.map((r) => r.id)).toEqual([4, 6, 9]);
	});

	it('shows an em dash for a missing branch, never blank', () => {
		const g = buildSidebar([ws('w', [s(1, 'running', { branch: '' }), s(2, 'running', { branch: '   ' })])], new Set())[0]!;
		expect(g.sections[0]!.rows.map((r) => r.branch)).toEqual(['—', '—']);
	});

	it('carries the branch through untouched — it is never shortened', () => {
		const long = 'wt/some-really-long-branch-name-that-would-not-fit-anywhere-42';
		const g = buildSidebar([ws('w', [s(1, 'running', { branch: long })])], new Set())[0]!;
		expect(g.sections[0]!.rows[0]!.branch).toBe(long);
	});

	it('adds a remote chip only for a session with remote control on', () => {
		const g = buildSidebar([ws('w', [s(1, 'running', { remoteOn: true }), s(2, 'running')])], new Set())[0]!;
		expect(g.sections[0]!.rows.map((r) => r.chips)).toEqual([['remote'], []]);
	});

	it('pins the overseer above the sections and keeps it out of them', () => {
		const g = buildSidebar([ws('w', [s(OVERSEER_ID, 'prompt', { name: 'Alpha', branch: '—' }), s(1, 'prompt')])], new Set())[0]!;
		expect(g.overseers.map((r) => r.name)).toEqual(['Alpha']);
		expect(g.overseers[0]!.overseer).toBe(true);
		expect(g.sections[0]!.rows.map((r) => r.id)).toEqual([1]);
	});

	it('marks the active workspace and passes the linked repo through', () => {
		const g = buildSidebar([ws('a', []), ws('b', [], { active: true, repo: 'chessedu' })], new Set());
		expect(g.map((x) => x.active)).toEqual([false, true]);
		expect(g[1]!.repo).toBe('chessedu');
	});
});

describe('buildSidebar — roll-up and collapse', () => {
	it('rolls a group up to its worst state: needs you > refused > running > idle', () => {
		const worst = (states: string[]) => buildSidebar([ws('w', states.map((st, i) => s(i + 1, st)))], new Set())[0]!.worst;
		expect(worst(['idle', 'running', 'errored', 'menu'])).toBe('needs');
		expect(worst(['idle', 'running', 'errored'])).toBe('refused');
		expect(worst(['idle', 'running'])).toBe('running');
		expect(worst(['idle'])).toBe('idle');
		expect(worst([])).toBeNull();
	});

	it('counts the overseer in the roll-up — an overseer waiting on you must not hide', () => {
		const g = buildSidebar([ws('w', [s(OVERSEER_ID, 'prompt', { name: 'Alpha' }), s(1, 'running')])], new Set(['w']))[0]!;
		expect(g.worst).toBe('needs');
		expect(g.counts.needs).toBe(1);
	});

	it('counts sessions per bucket', () => {
		const g = buildSidebar([ws('w', [s(1, 'prompt'), s(2, 'errored'), s(3, 'running'), s(4, 'idle'), s(5, 'idle')])], new Set())[0]!;
		expect(g.counts).toEqual({ needs: 2, running: 1, done: 2 });
	});

	it('a collapsed group drops its rows but keeps its worst state and counts', () => {
		const sessions = [s(OVERSEER_ID, 'running', { name: 'Alpha' }), s(1, 'prompt'), s(2, 'idle')];
		const open = buildSidebar([ws('w', sessions)], new Set())[0]!;
		const shut = buildSidebar([ws('w', sessions)], new Set(['w']))[0]!;
		expect(shut.collapsed).toBe(true);
		expect(shut.sections).toEqual([]);
		expect(shut.overseers).toEqual([]);
		expect(shut.worst).toBe(open.worst);
		expect(shut.counts).toEqual(open.counts);
		expect(shut.total).toBe(open.total);
	});

	it('a workspace whose sessions are not loaded yet says so instead of claiming it is empty', () => {
		const g = buildSidebar([ws('w', [], { live: false })], new Set())[0]!;
		expect(g.live).toBe(false);
		expect(g.total).toBe(0);
		expect(g.worst).toBeNull();
	});
});

describe('sidebarSignature', () => {
	it('is stable for the same view and changes when anything shown changes', () => {
		const a = buildSidebar([ws('w', [s(1, 'running')])], new Set());
		const b = buildSidebar([ws('w', [s(1, 'running')])], new Set());
		const c = buildSidebar([ws('w', [s(1, 'prompt')])], new Set());
		const d = buildSidebar([ws('w', [s(1, 'running')], { active: true })], new Set());
		expect(sidebarSignature(a)).toBe(sidebarSignature(b));
		expect(sidebarSignature(a)).not.toBe(sidebarSignature(c));
		expect(sidebarSignature(a)).not.toBe(sidebarSignature(d));
	});
});
