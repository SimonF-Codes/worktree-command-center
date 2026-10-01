import { indexProcesses, subtreePids, type ProcIndex, type ProcRow } from './process-snapshot';
import { formatBytes } from './session-memory';

/** "What is this machine spending memory on" — the System view's half of the memory panel.
 *
 *  Pure: process rows and service rows in, a view model out. The rows are the MemoryMonitor's own
 *  snapshot, never a second `Win32_Process` query; the services come from `Win32_Service`, a
 *  different class, asked only while the view is open (service-snapshot.ts). Everything here is
 *  read-only by design — see the panel for why no row in this view carries a button. */

/** One running service, as `Win32_Service` reports it. */
export interface ServiceRow {
	name: string;
	displayName: string;
	pid: number;
	/** The service's configured image path — for a shared-host service, `svchost.exe -k <group> …`.
	 *  Readable without elevation, which the hosting process's own command line is not. */
	pathName: string | null;
}

export interface ServiceSnapshot {
	services: ServiceRow[];
	/** Registered WSL distro names; [] when none are installed, null when it could not be read. */
	wslDistros: string[] | null;
}

/** Parse the service query's JSON. Tolerant by the same rule as parseSnapshot: an unreadable
 *  answer is "no data" (null), never a throw into a render loop. */
export function parseServiceSnapshot(raw: string): ServiceSnapshot | null {
	let data: unknown;
	try { data = JSON.parse(raw); } catch { return null; }
	if (!data || typeof data !== 'object') return null;
	const o = data as Record<string, unknown>;
	const list = o.services === undefined || o.services === null ? [] : Array.isArray(o.services) ? o.services : [o.services];
	const services: ServiceRow[] = [];
	for (const r of list) {
		if (!r || typeof r !== 'object') continue;
		const s = r as Record<string, unknown>;
		const pid = typeof s.ProcessId === 'number' && Number.isFinite(s.ProcessId) ? s.ProcessId : 0;
		if (pid <= 0 || typeof s.Name !== 'string') continue;
		services.push({
			name: s.Name,
			displayName: typeof s.DisplayName === 'string' ? s.DisplayName : s.Name,
			pid,
			pathName: typeof s.PathName === 'string' && s.PathName ? s.PathName : null,
		});
	}
	// ConvertTo-Json renders a one-element array as a bare string.
	const wsl = o.wsl;
	const wslDistros = Array.isArray(wsl) ? wsl.filter((d): d is string => typeof d === 'string')
		: typeof wsl === 'string' ? [wsl]
		: null;
	return { services, wslDistros };
}

const lower = (s: string): string => s.toLowerCase();
const isSvchost = (r: ProcRow): boolean => lower(r.name) === 'svchost.exe';
const MEM_COMPRESSION = 'memory compression';
const VMMEM = new Set(['vmmem', 'vmmemwsl']);

/** The `-k <group>` of an svchost command line or service image path, or null. */
export function svchostGroup(cmd: string | null | undefined): string | null {
	if (!cmd) return null;
	const m = /\s-k\s+"?([^\s"]+)"?/i.exec(cmd);
	return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------------------------
// svchost, by hosted service
// ---------------------------------------------------------------------------------------------

export interface SvchostHost {
	pid: number;
	rssBytes: number;
	services: Array<{ name: string; displayName: string }>;
	/** null when neither the process's command line nor any service it hosts names a group. */
	group: string | null;
}

export interface SvchostGroupTotal { group: string; hosts: number; services: number; rssBytes: number }

export interface SvchostBreakdown {
	processCount: number;
	serviceCount: number;
	totalBytes: number;
	/** Every host, heaviest first. */
	hosts: SvchostHost[];
	/** Totals per `-k` group, heaviest first. Hosts with no known group are NOT folded in here. */
	groups: SvchostGroupTotal[];
	/** Hosts whose group could not be determined, and what they hold. */
	ungrouped: { hosts: number; rssBytes: number };
	/** False when the service query has not answered (yet, or at all): names are then unknown,
	 *  which the view must say rather than render every host as hosting nothing. */
	servicesKnown: boolean;
}

/** Roll svchost up by the services it hosts.
 *
 *  The group comes from the process's own command line when the snapshot has one, else from the
 *  image path of any service it hosts — services sharing a process share its group by
 *  construction, and `Win32_Service.PathName` is readable without elevation where the protected
 *  process's command line is not (88 of 97 null on the machine this was written on). A host with
 *  neither has NO group; it is counted as such, never given a placeholder that reads as data. */
export function svchostBreakdown(rows: readonly ProcRow[], svc: ServiceSnapshot | null): SvchostBreakdown {
	const byPid = new Map<number, ServiceRow[]>();
	for (const s of svc?.services ?? []) {
		const list = byPid.get(s.pid);
		if (list) list.push(s); else byPid.set(s.pid, [s]);
	}
	const hosts: SvchostHost[] = rows.filter(isSvchost).map((r) => {
		const hosted = (byPid.get(r.pid) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
		const group = svchostGroup(r.cmd) ?? hosted.map((s) => svchostGroup(s.pathName)).find((g) => g !== null) ?? null;
		return {
			pid: r.pid,
			rssBytes: r.rssBytes,
			services: hosted.map((s) => ({ name: s.name, displayName: s.displayName })),
			group,
		};
	});
	hosts.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);

	const groups = new Map<string, SvchostGroupTotal>();
	const ungrouped = { hosts: 0, rssBytes: 0 };
	for (const h of hosts) {
		if (h.group === null) { ungrouped.hosts++; ungrouped.rssBytes += h.rssBytes; continue; }
		const g = groups.get(h.group) ?? { group: h.group, hosts: 0, services: 0, rssBytes: 0 };
		g.hosts++; g.services += h.services.length; g.rssBytes += h.rssBytes;
		groups.set(h.group, g);
	}
	return {
		processCount: hosts.length,
		serviceCount: hosts.reduce((a, h) => a + h.services.length, 0),
		totalBytes: hosts.reduce((a, h) => a + h.rssBytes, 0),
		hosts,
		groups: [...groups.values()].sort((a, b) => b.rssBytes - a.rssBytes || a.group.localeCompare(b.group)),
		ungrouped,
		servicesKnown: svc !== null,
	};
}

/** The headline that stops a 2 GB svchost total being read as one program using 2 GB. */
export function svchostHeadline(b: SvchostBreakdown): string {
	if (!b.processCount) return 'No svchost processes in this snapshot.';
	const heaviest = b.hosts[0]!;
	const services = b.servicesKnown ? ` hosting ${b.serviceCount} service${b.serviceCount === 1 ? '' : 's'}` : '';
	return `${formatBytes(b.totalBytes)} across ${b.processCount} separate process${b.processCount === 1 ? '' : 'es'}${services}`
		+ ` — the heaviest single one is ${formatBytes(heaviest.rssBytes)}. Not one program: since Windows 10, a machine `
		+ 'with more than 3.5 GB of RAM runs each service in its own svchost, so one crash cannot take its neighbours down.';
}

/** What the view says instead of printing "?" for a group it cannot see. Null when nothing is
 *  missing. */
export function svchostCaveat(b: SvchostBreakdown): string | null {
	if (!b.servicesKnown) {
		return b.processCount
			? 'Service names are not available yet — the service list (Win32_Service) has not answered.'
			: null;
	}
	if (!b.ungrouped.hosts) return null;
	const n = b.ungrouped.hosts;
	return `${n} svchost process${n === 1 ? '' : 'es'} (${formatBytes(b.ungrouped.rssBytes)}) `
		+ `${n === 1 ? 'has' : 'have'} no -k group shown: Windows hides a protected process's command line `
		+ `unless the app runs elevated, and no running service maps to ${n === 1 ? 'it' : 'them'} to name it instead. `
		+ 'Not counted in the group totals.';
}

/** How a host is named in the list: its services, then its group. */
export function hostLabel(h: SvchostHost, servicesKnown: boolean): string {
	if (!servicesKnown) return `svchost pid ${h.pid}`;
	if (!h.services.length) return `svchost pid ${h.pid} — no service reported`;
	const names = h.services.map((s) => s.name);
	return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

// ---------------------------------------------------------------------------------------------
// Machine attribution, by parentage
// ---------------------------------------------------------------------------------------------

/** Three different things share the image name `claude.exe`, and grouping by name is what once
 *  reported ten "leaked subagents" that were the desktop app's helpers. */
export type ClaudeKind = 'wcc' | 'desktop' | 'cli-outside';

/** An Electron main process always has at least a GPU process, a network utility process and a
 *  renderer as direct children of its own image — the desktop app's signature in the tree. A CLI
 *  session spawns at most the odd child of its own name. */
const ELECTRON_MIN_HELPERS = 3;

/** Parents a CLI is started from. A claude.exe rooted under one of these is a terminal session
 *  however many children it has; the desktop app is launched from the shell, not a console. */
const CONSOLE_PARENTS = new Set([
	'cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'zsh.exe', 'wsl.exe', 'node.exe',
	'conhost.exe', 'openconsole.exe', 'windowsterminal.exe', 'code.exe', 'mintty.exe',
]);

/** The WCC process tree: the app's pid walked up to the top of its own image (Electron's
 *  renderers and helpers share the main process's name), then everything beneath that. */
export function wccTree(ix: ProcIndex, appPid: number): number[] {
	let root = appPid;
	const seen = new Set<number>();
	for (;;) {
		const self = ix.byPid.get(root);
		const parent = self ? ix.byPid.get(self.ppid) : undefined;
		if (!self || !parent || seen.has(parent.pid) || lower(parent.name) !== lower(self.name)) break;
		seen.add(root);
		root = parent.pid;
	}
	return subtreePids(ix, root);
}

/** Classify every claude.exe in the snapshot by WHERE IT SITS, never by its name alone.
 *
 *  - inside the WCC tree → `wcc`
 *  - inside the tree of a claude.exe root that carries Electron's helper signature and was not
 *    started from a console → `desktop`
 *  - any other → `cli-outside`: a CLI session started outside the app, which nothing on the floor
 *    tracks and auto-close cannot reach. */
export function classifyClaude(rows: readonly ProcRow[], appPid: number): Map<number, ClaudeKind> {
	const ix = indexProcesses(rows);
	const wcc = new Set(wccTree(ix, appPid));
	const out = new Map<number, ClaudeKind>();
	const isClaude = (r: ProcRow | undefined): boolean => !!r && lower(r.name) === 'claude.exe';
	const kindOfRoot = (root: ProcRow): ClaudeKind => {
		const parent = ix.byPid.get(root.ppid);
		const helpers = (ix.kids.get(root.pid) ?? []).filter((k) => isClaude(ix.byPid.get(k))).length;
		const fromConsole = !!parent && CONSOLE_PARENTS.has(lower(parent.name));
		return helpers >= ELECTRON_MIN_HELPERS && !fromConsole ? 'desktop' : 'cli-outside';
	};
	for (const r of rows) {
		if (!isClaude(r)) continue;
		if (wcc.has(r.pid)) { out.set(r.pid, 'wcc'); continue; }
		// The TOPMOST claude.exe among its ancestors decides, through any shell in between — a CLI
		// the desktop app started (desktop → cmd → claude) belongs to the desktop app.
		let root = r;
		const seen = new Set<number>([r.pid]);
		for (let p = ix.byPid.get(r.ppid); p && !seen.has(p.pid); p = ix.byPid.get(p.ppid)) {
			seen.add(p.pid);
			if (isClaude(p)) root = p;
		}
		out.set(r.pid, kindOfRoot(root));
	}
	return out;
}

export interface TreeTotal { procCount: number; rssBytes: number }

export interface OutsideCli {
	rootPid: number;
	/** What started it, so it can be found: the shell's name, or null when that has exited. */
	parentName: string | null;
	claudeCount: number;
	procCount: number;
	rssBytes: number;
}

export interface ProgramTotal { name: string; procCount: number; rssBytes: number }

export interface MachineAttribution {
	wcc: TreeTotal;
	desktop: TreeTotal;
	/** CLI sessions outside the app, one entry per tree, heaviest first. */
	outsideCli: OutsideCli[];
	outsideCliTotal: TreeTotal & { claudeCount: number; claudeBytes: number };
	/** Everything else, grouped by program, heaviest first. svchost, Memory Compression and vmmem
	 *  are excluded: each has its own section, and listing them twice would double-count. */
	programs: ProgramTotal[];
	totalBytes: number;
}

/** Roll the whole machine up: the WCC tree, the Claude desktop app, CLI sessions nobody tracks,
 *  then everything else by program. Trees are whole subtrees, so a CLI's node and bash children
 *  are counted with the CLI, not under "node.exe". */
export function attributeMachine(rows: readonly ProcRow[], appPid: number): MachineAttribution {
	const ix = indexProcesses(rows);
	const kinds = classifyClaude(rows, appPid);
	const taken = new Set<number>();
	const rss = (p: number): number => ix.byPid.get(p)?.rssBytes ?? 0;
	const sumTree = (pids: readonly number[]): TreeTotal => {
		const fresh = pids.filter((p) => !taken.has(p));
		for (const p of fresh) taken.add(p);
		return { procCount: fresh.length, rssBytes: fresh.reduce((a, p) => a + rss(p), 0) };
	};

	const wcc = sumTree(wccTree(ix, appPid));

	// A root is a claude.exe with no claude.exe anywhere above it — the same rule classifyClaude
	// decides kinds by, so a tree is never split between two entries.
	const hasClaudeAncestor = (r: ProcRow): boolean => {
		const seen = new Set<number>([r.pid]);
		for (let p = ix.byPid.get(r.ppid); p && !seen.has(p.pid); p = ix.byPid.get(p.ppid)) {
			seen.add(p.pid);
			if (kinds.has(p.pid)) return true;
		}
		return false;
	};
	const rootsOf = (kind: ClaudeKind): ProcRow[] =>
		rows.filter((r) => kinds.get(r.pid) === kind && !hasClaudeAncestor(r));

	const desktop: TreeTotal = { procCount: 0, rssBytes: 0 };
	for (const r of rootsOf('desktop')) {
		const t = sumTree(subtreePids(ix, r.pid));
		desktop.procCount += t.procCount; desktop.rssBytes += t.rssBytes;
	}

	const outsideCli: OutsideCli[] = rootsOf('cli-outside').map((r) => {
		const pids = subtreePids(ix, r.pid).filter((p) => !taken.has(p));
		const claude = pids.filter((p) => kinds.get(p) === 'cli-outside');
		const t = sumTree(pids);
		return {
			rootPid: r.pid,
			parentName: ix.byPid.get(r.ppid)?.name ?? null,
			claudeCount: claude.length,
			...t,
		};
	}).sort((a, b) => b.rssBytes - a.rssBytes || a.rootPid - b.rootPid);
	const outsideClaude = rows.filter((r) => kinds.get(r.pid) === 'cli-outside');

	const programs = new Map<string, ProgramTotal>();
	for (const r of rows) {
		if (taken.has(r.pid)) continue;
		const n = lower(r.name);
		if (n === 'svchost.exe' || n === MEM_COMPRESSION || VMMEM.has(n)) continue;
		const key = n || '(unnamed)';
		const g = programs.get(key) ?? { name: r.name || '(unnamed)', procCount: 0, rssBytes: 0 };
		g.procCount++; g.rssBytes += r.rssBytes;
		programs.set(key, g);
	}

	return {
		wcc,
		desktop,
		outsideCli,
		outsideCliTotal: {
			procCount: outsideCli.reduce((a, c) => a + c.procCount, 0),
			rssBytes: outsideCli.reduce((a, c) => a + c.rssBytes, 0),
			claudeCount: outsideClaude.length,
			claudeBytes: outsideClaude.reduce((a, r) => a + r.rssBytes, 0),
		},
		programs: [...programs.values()].sort((a, b) => b.rssBytes - a.rssBytes || a.name.localeCompare(b.name)),
		totalBytes: rows.reduce((a, r) => a + r.rssBytes, 0),
	};
}

/** The sentence that makes the untracked CLI sessions visible. Null when there are none. */
export function outsideCliSummary(m: MachineAttribution): string | null {
	const t = m.outsideCliTotal;
	if (!t.claudeCount) return null;
	return `${t.claudeCount} claude.exe process${t.claudeCount === 1 ? '' : 'es'} holding ${formatBytes(t.claudeBytes)} `
		+ `belong${t.claudeCount === 1 ? 's' : ''} to neither this app nor the Claude desktop app — CLI sessions started `
		+ 'outside it. Nothing on the floor tracks them, and auto-close cannot reach them.';
}

// ---------------------------------------------------------------------------------------------
// VM-backed memory, and Memory Compression
// ---------------------------------------------------------------------------------------------

export interface VmBacked {
	/** The vmmem pseudo-processes, if any. */
	entries: Array<{ name: string; pid: number; rssBytes: number }>;
	totalBytes: number;
	/** What is behind it, in words — or that nothing is. */
	behind: string;
	/** The inventory that explains it: WSL distros, Docker, the Hyper-V compute service. */
	facts: string[];
}

const DOCKER = /^(com\.docker\.|docker desktop\.exe$|dockerd\.exe$)/i;

/** Name what is behind `vmmem` instead of printing a number nobody can act on.
 *
 *  vmmem is not a program and not a service: it is the accounting entry for a Hyper-V guest's
 *  memory. It cannot be stopped; the guest behind it can be. */
export function vmBacked(rows: readonly ProcRow[], wslDistros: string[] | null): VmBacked {
	const entries = rows.filter((r) => VMMEM.has(lower(r.name))).map((r) => ({ name: r.name, pid: r.pid, rssBytes: r.rssBytes }));
	const has = (name: string): boolean => rows.some((r) => lower(r.name) === name);
	const wslLive = has('vmmemwsl') || has('wslhost.exe') || has('wslrelay.exe');
	const dockerLive = rows.some((r) => DOCKER.test(r.name));
	const vmcompute = rows.filter((r) => lower(r.name) === 'vmcompute.exe').reduce((a, r) => a + r.rssBytes, 0);

	const distros = wslDistros === null ? 'WSL distros: could not be read'
		: wslDistros.length ? `WSL distros installed: ${wslDistros.join(', ')}` : 'No WSL distros installed';
	const facts = [
		distros,
		dockerLive ? 'Docker Desktop is running' : 'Docker is not running',
		has('vmcompute.exe') ? `Hyper-V compute service (vmcompute) ${formatBytes(vmcompute)} — the host service, idle unless a VM runs`
			: 'Hyper-V compute service is not running',
	];

	let behind: string;
	if (!entries.length) {
		behind = 'No virtual machine is running, so nothing is behind vmmem right now.';
	} else {
		const parts: string[] = [];
		if (wslLive) parts.push(wslDistros?.length ? `WSL (${wslDistros.join(', ')})` : 'WSL');
		if (dockerLive) parts.push('Docker Desktop');
		behind = (parts.length
			? `Behind it: ${parts.join(' and ')}.`
			: 'Behind it: a Hyper-V guest that is neither WSL nor Docker — Windows Sandbox, or a VM in Hyper-V Manager.')
			+ ' vmmem is the guest\'s memory as Windows accounts for it, not a program: it cannot be ended itself — '
			+ 'shutting the guest down is what releases it.';
	}
	return { entries, totalBytes: entries.reduce((a, e) => a + e.rssBytes, 0), behind, facts };
}

export interface CompressionRow { rssBytes: number; label: string }

/** Memory Compression, labelled as the symptom it is. Often the single biggest line, and acting
 *  on it is always wrong. Null when the snapshot does not contain it. */
export function memoryCompression(rows: readonly ProcRow[]): CompressionRow | null {
	const r = rows.find((x) => lower(x.name) === MEM_COMPRESSION);
	if (!r) return null;
	return {
		rssBytes: r.rssBytes,
		label: 'A symptom, not a consumer: Windows compressing memory pages because RAM is under pressure. '
			+ 'It grows when other things do and unwinds on its own once they free memory — free that, not this.',
	};
}

// ---------------------------------------------------------------------------------------------
// The whole view
// ---------------------------------------------------------------------------------------------

export interface SystemView {
	machine: MachineAttribution;
	svchost: SvchostBreakdown;
	vm: VmBacked;
	compression: CompressionRow | null;
}

export function buildSystemView(rows: readonly ProcRow[], appPid: number, svc: ServiceSnapshot | null): SystemView {
	return {
		machine: attributeMachine(rows, appPid),
		svchost: svchostBreakdown(rows, svc),
		vm: vmBacked(rows, svc?.wslDistros ?? null),
		compression: memoryCompression(rows),
	};
}
