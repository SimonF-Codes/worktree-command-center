import { describe, it, expect } from 'vitest';
import { parseSnapshot, findUsageProbeStrays, type ProcRow } from '../src/terminals/process-snapshot';

const PROBE = 'C:\\Users\\x\\AppData\\Roaming\\worktree-command-center\\usage-probe';
const sidecarCmd = (cwd: string) => `node.exe C:\\app\\resources\\pty-sidecar\\sidecar.cjs ${cwd} claude`;

function row(p: Partial<ProcRow> & { pid: number }): ProcRow {
	return { ppid: 1, name: 'node.exe', rssBytes: 0, ...p };
}

describe('parseSnapshot', () => {
	it('reads the array PowerShell emits for many rows', () => {
		const raw = JSON.stringify([
			{ ProcessId: 10, ParentProcessId: 4, Name: 'node.exe', WorkingSetSize: 2048, CommandLine: 'node a' },
			{ ProcessId: 11, ParentProcessId: 10, Name: 'cmd.exe', WorkingSetSize: 512 },
		]);
		expect(parseSnapshot(raw)).toEqual([
			{ pid: 10, ppid: 4, name: 'node.exe', rssBytes: 2048, cmd: 'node a' },
			{ pid: 11, ppid: 10, name: 'cmd.exe', rssBytes: 512 },
		]);
	});

	it('reads the BARE OBJECT PowerShell emits when exactly one row matches', () => {
		const raw = JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'node.exe', WorkingSetSize: 64 });
		expect(parseSnapshot(raw)).toEqual([{ pid: 7, ppid: 1, name: 'node.exe', rssBytes: 64 }]);
	});

	it('degrades to [] instead of throwing when the snapshot is unreadable', () => {
		expect(parseSnapshot('')).toEqual([]);
		expect(parseSnapshot('not json')).toEqual([]);
	});

	it('skips rows with no usable pid rather than inventing one', () => {
		expect(parseSnapshot(JSON.stringify([{ Name: 'x' }, { ProcessId: 5 }]))).toEqual([
			{ pid: 5, ppid: 0, name: '', rssBytes: 0 },
		]);
	});
});

describe('findUsageProbeStrays', () => {
	const APP = 100;

	it('reaps a probe sidecar left behind by a DEAD app instance', () => {
		const rows = [row({ pid: 100, ppid: 1, name: 'app.exe' }), row({ pid: 55, ppid: 999, cmd: sidecarCmd(PROBE) })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([55]);
	});

	it('reaps a probe sidecar parented to THIS app that no bridge claims — the leak', () => {
		const rows = [row({ pid: 100, ppid: 1, name: 'app.exe' }), row({ pid: 55, ppid: APP, cmd: sidecarCmd(PROBE) })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([55]);
	});

	it('never touches the pid a live probe is mid-refresh on', () => {
		const rows = [row({ pid: 100, ppid: 1, name: 'app.exe' }), row({ pid: 55, ppid: APP, cmd: sidecarCmd(PROBE) })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [55])).toEqual([]);
	});

	it('leaves a probe owned by ANOTHER LIVE app instance alone', () => {
		// Dev and installed builds share one userData profile, so a second instance's probe
		// runs in the same cwd. Its parent is alive and is not us — not ours to kill.
		const rows = [
			row({ pid: 100, ppid: 1, name: 'app.exe' }),
			row({ pid: 200, ppid: 1, name: 'app.exe' }),
			row({ pid: 55, ppid: 200, cmd: sidecarCmd(PROBE) }),
		];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([]);
	});

	it('NEVER reaps a sidecar in a real worktree, even an orphaned one', () => {
		const rows = [row({ pid: 55, ppid: 999, cmd: sidecarCmd('C:\\dev\\wt-main-3') })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([]);
	});

	it('ignores non-sidecar processes that merely mention the probe path', () => {
		const rows = [row({ pid: 55, ppid: 999, name: 'cmd.exe', cmd: `cmd /c dir ${PROBE}` })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([]);
	});

	it('matches regardless of slash direction and case', () => {
		const odd = 'c:/USERS/x/appdata/roaming/worktree-command-center/Usage-Probe';
		const rows = [row({ pid: 55, ppid: 999, cmd: sidecarCmd(odd) })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([55]);
	});

	it('skips rows with no command line instead of guessing', () => {
		const rows = [row({ pid: 55, ppid: 999 })];
		expect(findUsageProbeStrays(rows, PROBE, APP, [])).toEqual([]);
	});
});
