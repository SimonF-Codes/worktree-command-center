import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLibrary, findVaultRoot } from '../src/terminals/role-view-loader';

/** A throwaway role library on disk. The wrapper is thin, but it is the half that has to survive
 *  a missing folder, an unreadable file and no configuration at all — none of which can be tested
 *  purely, and all of which the vault (in OneDrive) actually produces. */
let dir = '';

const write = (name: string, text: string): void => { fs.writeFileSync(path.join(dir, name), text, 'utf8'); };

const ALPHA = [
	'---', 'role: alpha', 'name: Alpha', 'surface: worktree-command-center',
	'authority: operator', 'status: active', 'revised: 2026-09-05', 'custodian-reviewed:', '---',
	'', '## Mission', '', 'Overseer of the floor.',
].join('\n');

const CUSTODIAN = (status: string): string => [
	'---', 'role: agent-custodian', 'name: Agent Custodian', 'surface: vault',
	'authority: operator', `status: ${status}`, '---', '', '## Mission', '', 'Keeps the library sane.',
].join('\n');

const INDEX = [
	'## Agent registry',
	'',
	'| Role | Surface | Authority | Mission | Cadence | Status |',
	'|---|---|---|---|---|---|',
	'| [[Alpha]] | worktree-command-center | operator | Overseer of the floor | on request | active |',
	'| butler | brain-2.0 | proposer | Calm assistant | on request | active — not migrated (src/butler/session.ts) |',
].join('\n');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-roleview-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('readLibrary', () => {
	it('reads roles and the registry, and joins them on the slug', () => {
		write('Alpha.md', ALPHA);
		write('Index.md', INDEX);
		const snap = readLibrary(dir);
		expect(snap.configured).toBe(true);
		expect(snap.error).toBeNull();
		expect(snap.library.tiles.map((t) => t.slug)).toEqual(['alpha', 'butler']);
		expect(snap.library.coverage).toEqual({ withFile: 1, total: 2 });
		expect(snap.library.registryFound).toBe(true);
	});

	it('never treats Index.md, Charter.md or Summary.md as roles', () => {
		write('Alpha.md', ALPHA);
		write('Index.md', INDEX);
		write('Charter.md', '---\ntype: reference\nrole: charter\n---\n\n# Agent Charter');
		write('Summary.md', '---\nrole: summary\n---\n\n# Summary');
		const snap = readLibrary(dir);
		expect(snap.library.tiles.map((t) => t.slug)).toEqual(['alpha', 'butler']);
		expect(snap.library.unregistered).toEqual([]);
	});

	it('explains an unconfigured library rather than rendering blank', () => {
		const snap = readLibrary(undefined);
		expect(snap.configured).toBe(false);
		expect(snap.error).toBeNull();
		expect(snap.library.tiles).toEqual([]);
		expect(snap.custodian.ok).toBe(false);
	});

	it('reports an unreadable folder instead of throwing', () => {
		const snap = readLibrary(path.join(dir, 'does-not-exist'));
		expect(snap.error).toContain('does-not-exist');
		expect(snap.library.tiles).toEqual([]);
	});

	it('still renders the role files when Index.md is missing', () => {
		write('Alpha.md', ALPHA);
		const snap = readLibrary(dir);
		expect(snap.error).toBeNull();
		expect(snap.library.registryFound).toBe(false);
		expect(snap.library.tiles.map((t) => t.slug)).toEqual(['alpha']);
	});

	it('offers the Custodian action only when its role file would actually load', () => {
		write('Alpha.md', ALPHA);
		expect(readLibrary(dir).custodian).toEqual({ ok: false, reason: 'no role file declares role: agent-custodian' });

		write('Agent Custodian.md', CUSTODIAN('proposed'));
		const proposed = readLibrary(dir).custodian;
		expect(proposed.ok).toBe(false);
		expect(proposed.reason).toContain('proposed');

		write('Agent Custodian.md', CUSTODIAN('active'));
		expect(readLibrary(dir).custodian).toEqual({ ok: true, reason: '' });
	});
});

describe('findVaultRoot', () => {
	it('finds the folder above the library that holds .obsidian/', () => {
		const agents = path.join(dir, 'vault', '_meta', 'agents');
		fs.mkdirSync(agents, { recursive: true });
		fs.mkdirSync(path.join(dir, 'vault', '.obsidian'));
		expect(findVaultRoot(agents)).toBe(path.join(dir, 'vault').replace(/\\/g, '/'));
	});

	it('returns null when the library is not inside a vault', () => {
		expect(findVaultRoot(dir)).toBeNull();
	});
});
