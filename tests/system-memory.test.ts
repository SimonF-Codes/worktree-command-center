import { describe, it, expect } from 'vitest';
import type { ProcRow } from '../src/terminals/process-snapshot';
import {
	attributeMachine, buildSystemView, classifyClaude, hostLabel, memoryCompression, outsideCliSummary,
	parseServiceSnapshot, svchostBreakdown, svchostCaveat, svchostGroup, svchostHeadline, vmBacked,
	type ServiceRow, type ServiceSnapshot,
} from '../src/terminals/system-memory';

const MB = 1024 * 1024;
const p = (pid: number, ppid: number, name: string, mb: number, cmd?: string): ProcRow =>
	({ pid, ppid, name, rssBytes: mb * MB, ...(cmd === undefined ? {} : { cmd }) });

/** The machine the feature was designed against, in miniature. Pids are chosen so every group
 *  is easy to tell apart: 1xx WCC, 2xx desktop app, 3xx-5xx CLIs outside, 6xx svchost. */
const WCC_MAIN = 100;
const WCC_RENDERER = 101; // process.pid in the renderer — the pid the monitor measures from
const rows: ProcRow[] = [
	p(4, 0, 'System', 1),
	p(5, 4, 'Memory Compression', 1471),
	p(10, 4, 'wininit.exe', 2),
	p(11, 10, 'services.exe', 10),
	p(20, 4, 'explorer.exe', 200),
	p(21, 11, 'WindowsTerminal.exe', 90),
	p(22, 11, 'WmiPrvSE.exe', 20),
	p(23, 11, 'vmcompute.exe', 10),

	// WCC: main ← renderer ← node sidecar ← cmd ← claude (a session the floor tracks).
	p(WCC_MAIN, 20, 'Worktree Command Center.exe', 150),
	p(WCC_RENDERER, WCC_MAIN, 'Worktree Command Center.exe', 300),
	p(102, WCC_MAIN, 'Worktree Command Center.exe', 80), // gpu
	p(110, WCC_RENDERER, 'node.exe', 40),
	p(111, 110, 'cmd.exe', 5),
	p(112, 111, 'claude.exe', 350),

	// Claude desktop app: Electron main, launched from the shell, with its helpers…
	p(200, 20, 'claude.exe', 199),
	p(201, 200, 'claude.exe', 33), // crashpad
	p(202, 200, 'claude.exe', 104), // gpu
	p(203, 200, 'claude.exe', 66), // network utility
	p(204, 200, 'claude.exe', 316), // renderer
	// …and a Claude Code session IT started, through a shell. Still the desktop app's.
	p(205, 200, 'cmd.exe', 4),
	p(206, 205, 'claude.exe', 120),

	// CLI sessions run in Windows Terminal, outside WCC.
	p(300, 21, 'cmd.exe', 5),
	p(301, 300, 'claude.exe', 344),
	p(302, 301, 'node.exe', 30), // an MCP server the CLI started
	p(310, 21, 'cmd.exe', 5),
	// A CLI that happens to run three claude children at once. Same-name children alone would
	// make this look like an Electron app; started from a console, it is a terminal session.
	p(311, 310, 'claude.exe', 200),
	p(312, 311, 'claude.exe', 50),
	p(313, 311, 'claude.exe', 50),
	p(314, 311, 'claude.exe', 50),
	// A CLI whose parent has exited, with one claude child.
	p(400, 9999, 'claude.exe', 71),
	p(401, 400, 'claude.exe', 310),
	// A CLI started by WMI.
	p(500, 22, 'claude.exe', 119),

	// svchost: protected (no command line) except one.
	p(600, 11, 'svchost.exe', 92),
	p(601, 11, 'svchost.exe', 40),
	p(602, 11, 'svchost.exe', 30, 'C:\\Windows\\system32\\svchost.exe -k netsvcs -p -s Schedule'),
	p(603, 11, 'svchost.exe', 12), // hosts nothing Win32_Service reports

	// Everything else.
	p(700, 20, 'chrome.exe', 400),
	p(701, 700, 'chrome.exe', 300),
	p(710, 20, 'node.exe', 60), // a node NOT under any CLI — grouped by program
];

const svc = (name: string, pid: number, pathName: string | null): ServiceRow => ({ name, displayName: `${name} display`, pid, pathName });
const services: ServiceSnapshot = {
	services: [
		svc('DPS', 600, 'C:\\Windows\\System32\\svchost.exe -k LocalServiceNoNetwork -p'),
		svc('Audiosrv', 601, 'C:\\Windows\\System32\\svchost.exe -k LocalServiceNetworkRestricted -p'),
		svc('AudioEndpointBuilder', 601, 'C:\\Windows\\System32\\svchost.exe -k LocalServiceNetworkRestricted -p'),
		svc('Schedule', 602, null),
		svc('Spooler', 800, 'C:\\Windows\\System32\\spoolsv.exe'), // not an svchost — ignored here
	],
	wslDistros: [],
};

describe('svchostGroup', () => {
	it('reads the -k group from a command line or an image path', () => {
		expect(svchostGroup('C:\\Windows\\system32\\svchost.exe -k netsvcs -p')).toBe('netsvcs');
		expect(svchostGroup('svchost.exe -k "LocalService" -s W32Time')).toBe('LocalService');
		expect(svchostGroup('C:\\Windows\\System32\\spoolsv.exe')).toBeNull();
		expect(svchostGroup(null)).toBeNull();
		expect(svchostGroup(undefined)).toBeNull();
	});
});

describe('svchost broken down by hosted service', () => {
	const b = svchostBreakdown(rows, services);

	it('counts processes and the services they host, heaviest host first', () => {
		expect(b.processCount).toBe(4);
		expect(b.serviceCount).toBe(4);
		expect(b.totalBytes).toBe((92 + 40 + 30 + 12) * MB);
		expect(b.hosts.map((h) => h.pid)).toEqual([600, 601, 602, 603]);
		expect(b.hosts[1]!.services.map((s) => s.name)).toEqual(['AudioEndpointBuilder', 'Audiosrv']);
	});

	it('takes the group from Win32_Service when the process command line is hidden', () => {
		expect(b.hosts.find((h) => h.pid === 600)!.group).toBe('LocalServiceNoNetwork');
		expect(b.hosts.find((h) => h.pid === 601)!.group).toBe('LocalServiceNetworkRestricted');
		// …and from the command line when the snapshot has one, even if the service's path is null.
		expect(b.hosts.find((h) => h.pid === 602)!.group).toBe('netsvcs');
	});

	it('totals per -k group, and keeps the ungroupable host OUT of every group', () => {
		expect(b.groups).toEqual([
			{ group: 'LocalServiceNoNetwork', hosts: 1, services: 1, rssBytes: 92 * MB },
			{ group: 'LocalServiceNetworkRestricted', hosts: 1, services: 2, rssBytes: 40 * MB },
			{ group: 'netsvcs', hosts: 1, services: 1, rssBytes: 30 * MB },
		]);
		expect(b.ungrouped).toEqual({ hosts: 1, rssBytes: 12 * MB });
	});

	it('says why the group is missing instead of printing "?"', () => {
		const caveat = svchostCaveat(b)!;
		expect(caveat).toMatch(/1 svchost process \(12 MB\)/);
		expect(caveat).toMatch(/elevated/);
		expect(caveat).not.toContain('?');
		const ungrouped = b.hosts.find((h) => h.pid === 603)!;
		expect(ungrouped.group).toBeNull();
		expect(hostLabel(ungrouped, true)).toBe('svchost pid 603 — no service reported');
		expect(hostLabel(ungrouped, true)).not.toContain('?');
	});

	it('with every command line null AND no image paths, every host is ungrouped and the caveat says so', () => {
		const hidden = rows.map((r) => ({ ...r, cmd: undefined }));
		const noPaths: ServiceSnapshot = { ...services, services: services.services.map((s) => ({ ...s, pathName: null })) };
		const bb = svchostBreakdown(hidden, noPaths);
		expect(bb.groups).toEqual([]);
		expect(bb.ungrouped.hosts).toBe(4);
		// Service NAMES still come through — they are not what elevation hides.
		expect(hostLabel(bb.hosts[0]!, true)).toBe('DPS');
		expect(svchostCaveat(bb)).toMatch(/^4 svchost processes .* have no -k group shown/);
	});

	it('before the service list answers, it says names are pending rather than "hosts nothing"', () => {
		const bb = svchostBreakdown(rows, null);
		expect(bb.servicesKnown).toBe(false);
		expect(hostLabel(bb.hosts[0]!, false)).toBe('svchost pid 600');
		expect(svchostCaveat(bb)).toMatch(/not available yet/);
		expect(svchostHeadline(bb)).not.toMatch(/hosting/);
	});

	it('the headline names the count, the heaviest one, and why there are so many', () => {
		const h = svchostHeadline(b);
		expect(h).toMatch(/^174 MB across 4 separate processes hosting 4 services — the heaviest single one is 92 MB\./);
		expect(h).toMatch(/3\.5 GB/);
	});

	it('shortens a host carrying many services', () => {
		const many = { pid: 1, rssBytes: 0, group: 'DcomLaunch', services: ['A', 'B', 'C', 'D', 'E'].map((n) => ({ name: n, displayName: n })) };
		expect(hostLabel(many, true)).toBe('A, B, C +2 more');
	});
});

describe('claude.exe attributed by parentage, never by name', () => {
	const kinds = classifyClaude(rows, WCC_RENDERER);

	it('the CLI under WCC is WCC', () => {
		expect(kinds.get(112)).toBe('wcc');
	});

	it('the desktop app and its helpers are the desktop app — not ten leaked subagents', () => {
		for (const pid of [200, 201, 202, 203, 204]) expect(kinds.get(pid)).toBe('desktop');
	});

	it('a CLI the desktop app started through a shell is still the desktop app\'s', () => {
		expect(kinds.get(206)).toBe('desktop');
	});

	it('CLIs started outside both are cli-outside, however many claude children they have', () => {
		for (const pid of [301, 311, 312, 313, 314, 400, 401, 500]) expect(kinds.get(pid)).toBe('cli-outside');
	});

	it('every claude.exe in the snapshot gets exactly one kind', () => {
		const claude = rows.filter((r) => r.name === 'claude.exe').map((r) => r.pid);
		expect([...kinds.keys()].sort((a, b) => a - b)).toEqual(claude.sort((a, b) => a - b));
	});
});

describe('machine attribution', () => {
	const m = attributeMachine(rows, WCC_RENDERER);

	it('the WCC tree is the whole Electron app, found by walking up from the renderer pid', () => {
		expect(m.wcc).toEqual({ procCount: 6, rssBytes: (150 + 300 + 80 + 40 + 5 + 350) * MB });
	});

	it('the desktop app is its whole tree, including the session it started', () => {
		expect(m.desktop).toEqual({ procCount: 7, rssBytes: (199 + 33 + 104 + 66 + 316 + 4 + 120) * MB });
	});

	it('CLIs outside are listed per tree, with their children and what started them', () => {
		expect(m.outsideCli.map((c) => [c.rootPid, c.parentName, c.claudeCount, c.procCount])).toEqual([
			[400, null, 2, 2], // 381 MB
			[301, 'cmd.exe', 1, 2], // 374 MB — the MCP node goes with its CLI
			[311, 'cmd.exe', 4, 4], // 350 MB
			[500, 'WmiPrvSE.exe', 1, 1],
		]);
		expect(m.outsideCliTotal.claudeCount).toBe(8);
		expect(m.outsideCliTotal.claudeBytes).toBe((344 + 200 + 150 + 71 + 310 + 119) * MB);
	});

	it('names the gap: untracked, and out of auto-close\'s reach', () => {
		const s = outsideCliSummary(m)!;
		expect(s).toMatch(/^8 claude\.exe processes holding 1\.2 GB belong to neither this app nor the Claude desktop app/);
		expect(s).toMatch(/auto-close cannot reach them/);
		expect(outsideCliSummary(attributeMachine(rows.filter((r) => ![301, 311, 312, 313, 314, 400, 401, 500].includes(r.pid)), WCC_RENDERER))).toBeNull();
	});

	it('groups everything else by program, without the rows that have their own section', () => {
		const names = m.programs.map((x) => x.name);
		expect(m.programs[0]).toEqual({ name: 'chrome.exe', procCount: 2, rssBytes: 700 * MB });
		expect(names).not.toContain('svchost.exe');
		expect(names).not.toContain('Memory Compression');
		expect(names).not.toContain('claude.exe');
		// The cmd.exe shells under Windows Terminal are their own program; the ones inside a tree are not.
		expect(m.programs.find((x) => x.name === 'cmd.exe')).toEqual({ name: 'cmd.exe', procCount: 2, rssBytes: 10 * MB });
		expect(m.programs.find((x) => x.name === 'node.exe')).toEqual({ name: 'node.exe', procCount: 1, rssBytes: 60 * MB });
	});

	it('counts every process exactly once across the sections', () => {
		const svch = svchostBreakdown(rows, services).totalBytes;
		const comp = memoryCompression(rows)!.rssBytes;
		const sum = m.wcc.rssBytes + m.desktop.rssBytes + m.outsideCliTotal.rssBytes
			+ m.programs.reduce((a, x) => a + x.rssBytes, 0) + svch + comp;
		expect(sum).toBe(m.totalBytes);
	});

	it('survives a parent cycle from recycled pids', () => {
		const cyc = [p(1, 2, 'claude.exe', 1), p(2, 1, 'claude.exe', 1)];
		expect(() => attributeMachine(cyc, 999)).not.toThrow();
		expect(classifyClaude(cyc, 999).size).toBe(2);
	});
});

describe('VM-backed memory', () => {
	it('with no VM, says nothing is behind vmmem and lists what is installed', () => {
		const v = vmBacked(rows, []);
		expect(v.entries).toEqual([]);
		expect(v.behind).toMatch(/nothing is behind vmmem/);
		expect(v.facts).toEqual([
			'No WSL distros installed',
			'Docker is not running',
			'Hyper-V compute service (vmcompute) 10 MB — the host service, idle unless a VM runs',
		]);
	});

	it('names the WSL distro behind vmmemWSL, and that the guest is what can be shut down', () => {
		const v = vmBacked([...rows, p(900, 4, 'vmmemWSL', 858)], ['Ubuntu']);
		expect(v.totalBytes).toBe(858 * MB);
		expect(v.behind).toMatch(/^Behind it: WSL \(Ubuntu\)\./);
		expect(v.behind).toMatch(/not a program/);
		expect(v.facts[0]).toBe('WSL distros installed: Ubuntu');
	});

	it('names Docker when Docker is what is running', () => {
		const v = vmBacked([...rows, p(900, 4, 'vmmem', 2000), p(901, 20, 'com.docker.backend.exe', 100)], []);
		expect(v.behind).toMatch(/^Behind it: Docker Desktop\./);
	});

	it('a vmmem with neither WSL nor Docker is called a Hyper-V guest, not left blank', () => {
		expect(vmBacked([p(900, 4, 'vmmem', 500)], null).behind).toMatch(/neither WSL nor Docker/);
		expect(vmBacked([], null).facts[0]).toBe('WSL distros: could not be read');
	});
});

describe('Memory Compression', () => {
	it('is labelled as a symptom, never as an ordinary consumer', () => {
		const c = memoryCompression(rows)!;
		expect(c.rssBytes).toBe(1471 * MB);
		expect(c.label).toMatch(/^A symptom, not a consumer/);
		expect(c.label).toMatch(/unwinds on its own/);
		expect(memoryCompression([])).toBeNull();
	});
});

describe('parseServiceSnapshot', () => {
	it('reads the query\'s JSON, dropping stopped services', () => {
		const raw = JSON.stringify({
			services: [
				{ Name: 'DPS', DisplayName: 'Diagnostic Policy Service', ProcessId: 600, PathName: 'svchost.exe -k LocalServiceNoNetwork -p' },
				{ Name: 'Stopped', DisplayName: 'x', ProcessId: 0, PathName: null },
				{ Name: 'NoPath', ProcessId: 7, PathName: null },
			],
			wsl: ['Ubuntu', 'Debian'],
		});
		expect(parseServiceSnapshot(raw)).toEqual({
			services: [
				{ name: 'DPS', displayName: 'Diagnostic Policy Service', pid: 600, pathName: 'svchost.exe -k LocalServiceNoNetwork -p' },
				{ name: 'NoPath', displayName: 'NoPath', pid: 7, pathName: null },
			],
			wslDistros: ['Ubuntu', 'Debian'],
		});
	});

	it('copes with ConvertTo-Json\'s single-element shapes', () => {
		const raw = JSON.stringify({ services: { Name: 'A', DisplayName: 'A', ProcessId: 5, PathName: '' }, wsl: 'Ubuntu' });
		expect(parseServiceSnapshot(raw)).toEqual({ services: [{ name: 'A', displayName: 'A', pid: 5, pathName: null }], wslDistros: ['Ubuntu'] });
	});

	it('an empty list is "none installed", a null is "could not be read", garbage is no data', () => {
		expect(parseServiceSnapshot('{"services":[],"wsl":[]}')!.wslDistros).toEqual([]);
		expect(parseServiceSnapshot('{"services":[],"wsl":null}')!.wslDistros).toBeNull();
		expect(parseServiceSnapshot('')).toBeNull();
		expect(parseServiceSnapshot('not json')).toBeNull();
	});
});

describe('buildSystemView', () => {
	it('builds every section from one process snapshot and one service answer', () => {
		const v = buildSystemView(rows, WCC_RENDERER, services);
		expect(v.machine.wcc.procCount).toBe(6);
		expect(v.svchost.processCount).toBe(4);
		expect(v.vm.facts[0]).toBe('No WSL distros installed');
		expect(v.compression?.rssBytes).toBe(1471 * MB);
	});
});
