import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { FloorReportPublisher, writeReportPair, type PublishFs } from '../src/terminals/floor-report-publisher';
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
