import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
	FloorReportPublisher, writeReportPair, vaultReportTarget, vaultWriteDue, writeVaultReport, VAULT_WRITE_MIN_INTERVAL_MS,
	type PublishFs, type VaultFs,
} from '../src/terminals/floor-report-publisher';
import { buildFloorReport, renderFloorReport, type FloorReport } from '../src/terminals/floor-report';

/** An in-memory disk. `failOn` makes any path containing it throw, the way a locked file does. */
function memFs(failOn?: string): PublishFs & { files: Map<string, string>; ops: string[] } {
	const files = new Map<string, string>();
	const ops: string[] = [];
	const guard = (p: string): void => { if (failOn && p.includes(failOn)) throw new Error(`EBUSY: ${p}`); };
	return {
		files, ops,
		mkdir: async (d) => { guard(d); ops.push(`mkdir ${d}`); },
		writeFile: async (f, data) => { guard(f); ops.push(`write ${path.basename(f)}`); files.set(f, data); },
		rename: async (a, b) => { guard(b); ops.push(`rename ${path.basename(a)} → ${path.basename(b)}`); files.set(b, files.get(a)!); files.delete(a); },
	};
}

const report = (now = Date.parse('2026-09-27T22:00:00Z')): FloorReport => buildFloorReport({
	now, workspaces: [{ id: 'default', name: 'default' }], activeWorkspaceId: 'default',
	targets: [], scans: [], claims: [], memory: null, machine: null, sessionGroups: {},
});

describe('writeReportPair', () => {
	it('writes both renderings through a temp file and a rename', async () => {
		const fsx = memFs();
		const rendered = renderFloorReport(report());
		expect(await writeReportPair('C:/coord', rendered, fsx)).toBe(true);
		expect(fsx.files.get(path.join('C:/coord', 'floor-report.json'))).toBe(rendered.json);
		expect(fsx.files.get(path.join('C:/coord', 'floor-report.md'))).toBe(rendered.markdown);
		expect([...fsx.files.keys()].some((k) => k.endsWith('.tmp'))).toBe(false);
		expect(fsx.ops).toContain('rename floor-report.json.tmp → floor-report.json');
	});

	it('returns false instead of throwing when the disk refuses', async () => {
		expect(await writeReportPair('C:/coord', renderFloorReport(report()), memFs('floor-report'))).toBe(false);
	});
});

describe('FloorReportPublisher', () => {
	it('publishes the gathered report and remembers it', async () => {
		const fsx = memFs();
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: fsx, gather: async () => report() });
		const r = await pub.publish();
		expect(r).toEqual(report());
		expect(pub.latest()).toEqual(r);
		expect(JSON.parse(fsx.files.get(path.join('C:/coord', 'floor-report.json'))!)).toEqual(r);
	});

	it('a gather that throws resolves null and never rejects', async () => {
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: memFs(), gather: async () => { throw new Error('boom'); } });
		const orig = console.error; console.error = () => {};
		try { expect(await pub.publish()).toBeNull(); } finally { console.error = orig; }
	});

	it('serializes publishes so two refreshes never interleave their writes', async () => {
		const fsx = memFs();
		let n = 0;
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: fsx, gather: async () => report(Date.parse('2026-09-27T22:00:00Z') + ++n * 1000) });
		const [a, b] = await Promise.all([pub.publish(), pub.publish()]);
		expect(a!.generatedAt < b!.generatedAt).toBe(true);
		const writes = fsx.ops.filter((o) => o.startsWith('write'));
		expect(writes).toEqual(['write floor-report.json.tmp', 'write floor-report.md.tmp', 'write floor-report.json.tmp', 'write floor-report.md.tmp']);
		expect(JSON.parse(fsx.files.get(path.join('C:/coord', 'floor-report.json'))!).generatedAt).toBe(b!.generatedAt);
	});
});

/** A vault that has Personal/Code, records every write, and can be told to refuse or stall. */
function vaultFs(opts: { hasDir?: boolean; failWrites?: boolean; stall?: boolean } = {}): VaultFs & { writes: string[]; release: () => void } {
	const writes: string[] = [];
	let release = (): void => {};
	const gate = opts.stall ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
	return {
		writes, release: () => release(),
		isDirectory: async () => opts.hasDir ?? true,
		writeFile: async (f) => { await gate; if (opts.failWrites) throw new Error('EBUSY: locked by Obsidian'); writes.push(f); },
	};
}

const LIB = 'C:/Users/me/OneDrive/Documents/Vault/_meta/agents';

describe('vaultReportTarget', () => {
	it('puts the two files in <vault>/Personal/Code, the vault being the folder above _meta', () => {
		const t = vaultReportTarget(LIB)!;
		expect(t.dir).toBe(path.join('C:/Users/me/OneDrive/Documents/Vault', 'Personal', 'Code'));
		expect(t.markdown).toBe(path.join(t.dir, 'Floor Report.md'));
		expect(t.json).toBe(path.join(t.dir, 'floor-report.json'));
		expect(vaultReportTarget('C:\\Users\\me\\Vault\\_meta\\agents\\')!.dir).toBe(path.join('C:/Users/me/Vault', 'Personal', 'Code'));
	});

	it('is off with no role library, and off rather than guessing for any other layout', () => {
		expect(vaultReportTarget(undefined)).toBeNull();
		expect(vaultReportTarget('   ')).toBeNull();
		expect(vaultReportTarget('C:/roles')).toBeNull();
		expect(vaultReportTarget('C:/Vault/agents')).toBeNull();
		expect(vaultReportTarget('C:/Vault/_meta/agents/extra')).toBeNull();
	});
});

describe('vaultWriteDue', () => {
	it('writes the first time and on demand, otherwise at most every few minutes', () => {
		expect(vaultWriteDue(null, 1_000, false)).toBe(true);
		expect(vaultWriteDue(1_000, 1_000 + 30_000, false)).toBe(false); // a 30s scan: no
		expect(vaultWriteDue(1_000, 1_000 + VAULT_WRITE_MIN_INTERVAL_MS - 1, false)).toBe(false);
		expect(vaultWriteDue(1_000, 1_000 + VAULT_WRITE_MIN_INTERVAL_MS, false)).toBe(true);
		expect(vaultWriteDue(1_000, 1_001, true)).toBe(true); // the button
		expect(VAULT_WRITE_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(3 * 60_000);
	});
});

describe('writeVaultReport', () => {
	const rendered = renderFloorReport(report());

	it('overwrites exactly the two files, JSON then note', async () => {
		const v = vaultFs();
		const t = vaultReportTarget(LIB)!;
		expect(await writeVaultReport(t, rendered, v)).toBe(true);
		expect(v.writes).toEqual([t.json, t.markdown]);
	});

	it('does nothing at all when no vault is configured', async () => {
		const v = vaultFs();
		let asked = false;
		v.isDirectory = async () => { asked = true; return true; };
		expect(await writeVaultReport(null, rendered, v)).toBe(false);
		expect(asked).toBe(false);
		expect(v.writes).toEqual([]);
	});

	it('never creates Personal/Code — a vault laid out differently is simply not written', async () => {
		const v = vaultFs({ hasDir: false });
		expect(await writeVaultReport(vaultReportTarget(LIB), rendered, v)).toBe(false);
		expect(v.writes).toEqual([]);
	});

	it('swallows a locked file or an offline placeholder, returning false', async () => {
		await expect(writeVaultReport(vaultReportTarget(LIB), rendered, vaultFs({ failWrites: true }))).resolves.toBe(false);
		const throwingDir: VaultFs = { isDirectory: async () => { throw new Error('ENOTCONN'); }, writeFile: async () => {} };
		await expect(writeVaultReport(vaultReportTarget(LIB), rendered, throwingDir)).resolves.toBe(false);
	});
});

describe('FloorReportPublisher — the vault copy', () => {
	const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
		const orig = console.warn; console.warn = () => {};
		try { return await fn(); } finally { console.warn = orig; }
	};

	it('with no role library, publishes in-app and never touches a vault', async () => {
		const disk = memFs();
		const v = vaultFs();
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: disk, gather: async () => report(), vault: { target: vaultReportTarget(undefined), fs: v } });
		expect(await pub.publish({ onDemand: true })).not.toBeNull();
		expect(await pub.vaultSettled()).toBeNull();
		expect(v.writes).toEqual([]);
		expect(disk.files.has(path.join('C:/coord', 'floor-report.json'))).toBe(true);
	});

	it('throttles scan-driven vault writes separately from the in-app refresh', async () => {
		let now = 0;
		const disk = memFs();
		const v = vaultFs();
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: disk, gather: async () => report(), vault: { target: vaultReportTarget(LIB), fs: v }, now: () => now });
		for (let i = 0; i < 10; i++) { // five minutes of 30s scans
			await pub.publish();
			await pub.vaultSettled();
			now += 30_000;
		}
		expect(disk.ops.filter((o) => o === 'write floor-report.json.tmp')).toHaveLength(10); // in-app: every scan
		expect(v.writes.filter((f) => f.endsWith('.json'))).toHaveLength(1);                  // vault: once
		await pub.publish(); await pub.vaultSettled();                                       // 5 min after the first
		expect(v.writes.filter((f) => f.endsWith('.json'))).toHaveLength(2);
		await pub.publish({ onDemand: true }); await pub.vaultSettled();                     // the button: now
		expect(v.writes.filter((f) => f.endsWith('.json'))).toHaveLength(3);
	});

	it('a stalled vault write holds up neither later refreshes nor a second vault write', async () => {
		const disk = memFs();
		const v = vaultFs({ stall: true });
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: disk, gather: async () => report(), vault: { target: vaultReportTarget(LIB), fs: v } });
		await pub.publish({ onDemand: true });  // starts a vault write that hangs
		await pub.publish({ onDemand: true });  // resolves anyway, and does not stack a second write
		expect(disk.ops.filter((o) => o === 'write floor-report.json.tmp')).toHaveLength(2);
		v.release();
		await pub.vaultSettled();
		expect(v.writes).toHaveLength(2);       // the one write's two files, not four
	});

	it('a failing vault never fails the publish', async () => {
		const pub = new FloorReportPublisher({ coordRoot: 'C:/coord', fs: memFs(), gather: async () => report(), vault: { target: vaultReportTarget(LIB), fs: vaultFs({ failWrites: true }) } });
		const r = await quiet(async () => { const out = await pub.publish({ onDemand: true }); await pub.vaultSettled(); return out; });
		expect(r).not.toBeNull();
	});
});
