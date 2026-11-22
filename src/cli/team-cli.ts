import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { foldWorkstreams } from '../../pty-sidecar/workstreams-core.cjs';
import { foldProposals } from '../../pty-sidecar/proposals-core.cjs';
import { parseAttentionLog } from '../core/attention-log';
import {
	buildProjectReport, metricIsHonest, SLACK_MS, WINDOW_MS,
	type FloorFacts, type GitCommit, type GitFacts, type ProjectInputs, type ProjectReport, type Sourced, type VaultFacts, type VaultLogEntry,
} from '../core/metrics';
import { readIsolationLog } from '../terminals/isolation-log';
import { linkedRepo, reposForWorkspace } from '../workspace';
import type { RepoConfig } from '../terminals/terminals-grid';
import { defaultUserData } from './worktrees-cli';

// wcc-team — the floor's team-level read verbs. Today one: `metrics`, the Project panel's numbers
// (V2 Team Floor step 11, design §4). It runs as a CHILD PROCESS of the app (D11): git must never
// run in the renderer's process, and the panel must not become a second implementation of this.
// Every number is computed by core/metrics.ts; this file only gathers the facts, and times them.
//
// NFR-2: it prints its own wall time and every git call it made, on stderr, every run — the cost is
// measured, not asserted. Read-only throughout: it writes nothing anywhere.

export const EXIT = { ok: 0, failed: 1, usage: 64 } as const;

const USAGE = `usage: wcc-team metrics [--json] [--workspace <id>] [--user-data <dir>]

  metrics            The Project panel's metrics for every workspace (or one), with the source of
                     each and, for one that cannot be computed, the reason instead of a value.
  --json             The ProjectReport objects as JSON on stdout (what the app reads).
  --workspace <id>   One workspace only (the panel asks for the one it shows).
  --user-data <dir>  The app's data folder (default %APPDATA%/worktree-command-center; or WCC_USER_DATA).

Always prints its wall time and every git call it made to stderr.
Exit: 0 done · 1 failed · 64 usage.`;

export interface GitCall { repo: string; args: string[]; ms: number; code: number | null; bytes: number }
export interface Timing { wallMs: number; processMs: number; workspaces: number; repos: number; gitCalls: GitCall[]; gitMs: number }
export interface TeamMetricsOutput { schema: 1; generatedAt: number; workspaces: ProjectReport[]; timing: Timing }

export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface TeamCliDeps {
	out: (s: string) => void;
	err: (s: string) => void;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	now: () => number;
	git: GitRunner;
	/** For the wall time: performance.now()-like, ms. */
	clock: () => number;
}

const realGit: GitRunner = (cwd, args) => new Promise((resolve) => {
	execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 60_000, encoding: 'utf8' }, (e, stdout, stderr) => {
		const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : null) : 0;
		resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (e ? e.message : '') });
	});
});

interface Args { json: boolean; workspace?: string; userData?: string }

export function parseTeamArgs(argv: readonly string[]): Args | string {
	const [cmd, ...rest] = argv;
	if (cmd !== 'metrics') return cmd ? `unknown command "${cmd}"` : 'no command';
	const a: Args = { json: false };
	for (let i = 0; i < rest.length; i++) {
		const x = rest[i]!;
		if (x === '--json') a.json = true;
		else if (x === '--timing') { /* always on; accepted for the design's spelling */ }
		else if (x === '--workspace' || x === '--user-data') {
			const v = rest[++i];
			if (!v) return `${x} needs a value`;
			if (x === '--workspace') a.workspace = v; else a.userData = v;
		} else return `unknown option ${x}`;
	}
	return a;
}

export type RepoFrom = 'link' | 'group' | 'name' | 'sessions';

/** Which repo stands for a workspace, and how that was decided (the panel shows it). In order: the
 *  tab's link; the one repo tagged to this workspace; a repo whose name IS the workspace's
 *  ("Brain 2.0" ≡ Brain_2.0); the repo most of its saved terminals work in. Otherwise none — and the
 *  git rows say "no repo" while the task rows still work.
 *
 *  Deliberately NOT the toolbar's selected repo: that is a habit, not a declaration. On the machine
 *  this was built on, seven of ten toolbars still select the app's own repo, and taking it showed
 *  worktree-command-center's merges under "Music Generation". */
export function projectRepo(
	ws: { id: string; name: string; repo?: string }, repos: RepoConfig[], sessionRepos: readonly string[],
): { name: string; path: string; folder: boolean; from: RepoFrom } | null {
	const pick = (r: RepoConfig, from: RepoFrom) => ({ name: r.name, path: r.path, folder: Boolean(r.folder), from });
	const linked = linkedRepo(repos, ws.repo);
	if (linked) return pick(linked, 'link');
	const tagged = repos.filter((r) => r.group === ws.id);
	if (tagged.length === 1) return pick(tagged[0]!, 'group');
	const visible = reposForWorkspace(repos, ws.id);
	const named = visible.filter((r) => projectKey(r.name) === projectKey(ws.name));
	if (named.length === 1) return pick(named[0]!, 'name');
	const counts = new Map<string, number>();
	for (const n of sessionRepos) counts.set(n, (counts.get(n) ?? 0) + 1);
	const top = [...counts].sort((a, b) => b[1] - a[1]);
	const clear = top.length === 1 || (top.length > 1 && top[0]![1] > top[1]![1]);
	const used = clear ? visible.find((r) => r.name === top[0]![0]) : undefined;
	return used ? pick(used, 'sessions') : null;
}

/** Lower-case letters and digits only: "Worktree Command Center" ≡ "worktree-command-center". */
export const projectKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The vault root: two up from a `<vault>/_meta/agents` role library, else the nearest ancestor
 *  holding `.obsidian`. Null when no role library is configured. */
export function vaultRootOf(roleLibraryPath: string | undefined, exists: (p: string) => boolean): string | null {
	if (!roleLibraryPath?.trim()) return null;
	const p = path.resolve(roleLibraryPath.trim());
	const parts = p.split(/[\\/]+/);
	if (parts.length >= 3 && parts[parts.length - 1]!.toLowerCase() === 'agents' && parts[parts.length - 2]!.toLowerCase() === '_meta') return path.dirname(path.dirname(p));
	for (let d = p; ; d = path.dirname(d)) {
		if (exists(path.join(d, '.obsidian'))) return d;
		if (path.dirname(d) === d) return null;
	}
}

/** The top-level bullets of a vault log, each reduced to its first line with the bold dropped. */
export function logBullets(text: string): Array<{ text: string; highlight: boolean }> {
	const out: Array<{ text: string; highlight: boolean }> = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = /^- (.+)$/.exec(lines[i]!);
		if (!m) continue;
		// A bullet continues over its indented lines; highlight:: may sit on any of them.
		let block = m[1]!;
		for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]!); j++) block += `\n${lines[j]}`;
		const first = m[1]!.replace(/\*\*/g, '').replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, '$2').trim();
		const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
		out.push({ text: sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence, highlight: /\bhighlight::/.test(block) });
	}
	return out;
}

async function gatherGit(
	repo: { name: string; path: string; folder: boolean }, toolbarBranch: string | undefined, now: number,
	run: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>,
): Promise<Sourced<GitFacts>> {
	if (repo.folder) return { ok: false, reason: `${repo.name} is a folder target, not a git repo` };
	if (!fs.existsSync(repo.path)) return { ok: false, reason: `the repo is not at ${repo.path}` };
	const heads = [...new Set(['main', 'master', ...(toolbarBranch ? [toolbarBranch] : [])])];
	const refs = await run(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(creatordate:unix)', ...heads.map((h) => `refs/heads/${h}`), 'refs/tags']);
	if (refs.code !== 0) return { ok: false, reason: `git for-each-ref failed in ${repo.path}: ${refs.stderr.split('\n')[0] || `exit ${refs.code}`}` };
	const rows = refs.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
	const tipOf = new Map(rows.filter((r) => r[0]!.startsWith('refs/heads/')).map((r) => [r[0]!.slice(11), r[1]!]));
	const mainline = heads.find((h) => tipOf.has(h));
	if (!mainline) return { ok: false, reason: `no ${heads.join(' or ')} branch in ${repo.name}` };
	const tags = rows.filter((r) => r[0]!.startsWith('refs/tags/')).map((r) => ({ name: r[0]!.slice(10), ts: Number(r[2]) * 1000 })).filter((t) => Number.isFinite(t.ts));
	const since = new Date(now - WINDOW_MS - SLACK_MS).toISOString().slice(0, 10);
	const log = await run(['log', `--since=${since}`, '--format=%x1e%H%x1f%P%x1f%ct%x1f%at%x1f%s%x1f%b', mainline]);
	if (log.code !== 0) return { ok: false, reason: `git log failed in ${repo.path}: ${log.stderr.split('\n')[0] || `exit ${log.code}`}` };
	const commits: GitCommit[] = [];
	for (const rec of log.stdout.split('\x1e')) {
		if (!rec.trim()) continue;
		const [sha, parents, ct, at, subject, body] = rec.replace(/^\n/, '').split('\x1f');
		if (!sha || !ct) continue;
		const ts = Number(ct) * 1000;
		commits.push({ sha, parents: parents ? parents.split(' ').filter(Boolean) : [], ts, authorTs: Number(at) * 1000 || ts, subject: subject ?? '', body: body ?? '' });
	}
	return {
		ok: true,
		value: {
			repo: repo.name, mainline, tip: tipOf.get(mainline)!, commits, tags,
			logCommand: `git -C ${repo.path} log --since=${since} ${mainline}`,
			tagCommand: `git -C ${repo.path} for-each-ref refs/tags`,
			readAt: now,
		},
	};
}

function gatherVault(vaultRoot: string | null, keys: Set<string>, now: number, listing: Map<string, string[] | null>): Sourced<VaultFacts> {
	if (!vaultRoot) return { ok: false, reason: 'vault not configured' };
	if (!fs.existsSync(vaultRoot)) return { ok: false, reason: `the vault is not reachable at ${vaultRoot}` };
	const list = (rel: string): string[] | null => {
		if (!listing.has(rel)) { try { listing.set(rel, fs.readdirSync(path.join(vaultRoot, rel))); } catch { listing.set(rel, null); } }
		return listing.get(rel)!;
	};
	const logsDir = 'Personal/Code/Logs';
	const logs: VaultLogEntry[] = [];
	const logProjects = new Set<string>();
	for (const f of list(logsDir) ?? []) {
		const m = /^(\d{4}-\d{2}-\d{2}) — (.+)\.md$/.exec(f);
		if (!m || !keys.has(projectKey(m[2]!))) continue;
		logProjects.add(m[2]!);
		const ts = Date.parse(`${m[1]}T00:00:00`);
		if (!Number.isFinite(ts) || ts < now - WINDOW_MS) continue;
		let text = '';
		try { text = fs.readFileSync(path.join(vaultRoot, logsDir, f), 'utf8'); } catch { continue; }
		for (const b of logBullets(text)) logs.push({ date: m[1]!, ts, file: `${logsDir}/${f}`, ...b });
	}
	const proposalsDir = 'Personal/Code/Proposals';
	const names = list(proposalsDir);
	let proposals: VaultFacts['proposals'] = null;
	if (names) {
		proposals = [];
		for (const f of names.filter((n) => n.endsWith('.md'))) {
			try {
				const full = path.join(vaultRoot, proposalsDir, f);
				const text = fs.readFileSync(full, 'utf8');
				const proj = /^project::\s*(?:\[\[(?:[^|\]]*\|)?)?([^\]\n]+)/m.exec(text)?.[1];
				if (!proj || !keys.has(projectKey(proj))) continue;
				proposals.push({ file: `${proposalsDir}/${f}`, ts: fs.statSync(full).mtimeMs, title: f.replace(/\.md$/, '') });
			} catch { /* unreadable note — skip */ }
		}
		proposals.sort((a, b) => b.ts - a.ts);
	}
	return { ok: true, value: { logs, logsDir, logProjects: [...logProjects], proposals, proposalsDir, readAt: now } };
}

function gatherFloor(coordRoot: string, workspaceId: string): Sourced<FloorFacts> {
	let raw: { generatedAt?: string; terminals?: Array<Record<string, unknown>>; worktrees?: Array<Record<string, unknown>> };
	try { raw = JSON.parse(fs.readFileSync(path.join(coordRoot, 'floor-report.json'), 'utf8')); } catch {
		return { ok: false, reason: 'no floor report yet — the app writes floor-report.json after its first worktree scan' };
	}
	const generatedAt = Date.parse(String(raw.generatedAt));
	if (!Number.isFinite(generatedAt)) return { ok: false, reason: 'floor-report.json has no generatedAt' };
	return {
		ok: true,
		value: {
			generatedAt,
			terminals: (raw.terminals ?? []).filter((t) => t.tabId === workspaceId).map((t) => ({
				name: String(t.name), status: t.status === 'idle' ? 'idle' : 'busy', idleSince: typeof t.idleSince === 'string' ? t.idleSince : null, dead: t.dead === true, hidden: t.hidden === true,
			})),
			worktrees: (raw.worktrees ?? []).map((w) => ({
				repo: String(w.repo), branch: String(w.branch), state: String(w.state), heldBy: typeof w.heldBy === 'string' ? w.heldBy : null,
			})),
		},
	};
}

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** From the sessions file: sessionId → name (for owners), and each workspace's saved terminals'
 *  repos (for projectRepo). Unreadable → neither, and owners show as their ids. */
function readSessions(userData: string): { names: Record<string, string>; reposByWorkspace: Record<string, string[]> } {
	const names: Record<string, string> = {};
	const reposByWorkspace: Record<string, string[]> = {};
	try {
		const all = JSON.parse(fs.readFileSync(path.join(userData, '.terminal-sessions.json'), 'utf8')) as Record<string, unknown>;
		for (const [key, v] of Object.entries(all)) {
			if (!Array.isArray(v)) continue;
			for (const r of v as Array<Record<string, unknown>>) {
				if (typeof r?.sessionId === 'string' && typeof r.name === 'string') names[r.sessionId] = r.name;
				if (r?.kind === 'terminal' && typeof r.repoName === 'string') (reposByWorkspace[key] ??= []).push(r.repoName);
			}
		}
	} catch { /* nothing to attribute from */ }
	return { names, reposByWorkspace };
}

export async function main(argv: readonly string[], partial: Partial<TeamCliDeps> = {}): Promise<number> {
	const d: TeamCliDeps = {
		out: (s) => process.stdout.write(`${s}\n`),
		err: (s) => process.stderr.write(`${s}\n`),
		env: process.env,
		platform: process.platform,
		now: () => Date.now(),
		git: realGit,
		clock: () => performance.now(),
		...partial,
	};
	const t0 = d.clock();
	if (argv.includes('-h') || argv.includes('--help')) { d.out(USAGE); return EXIT.ok; }
	const a = parseTeamArgs(argv);
	if (typeof a === 'string') { d.err(`wcc-team: ${a}\n\n${USAGE}`); return EXIT.usage; }

	const userData = a.userData ?? defaultUserData(d.env, d.platform);
	let cfg: Record<string, unknown>;
	try { cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')) as Record<string, unknown>; } catch (e) {
		d.err(`wcc-team: cannot read ${path.join(userData, 'config.json')}: ${(e as Error).message}`);
		return EXIT.failed;
	}
	const repos = (Array.isArray(cfg.repos) ? cfg.repos : []) as RepoConfig[];
	const allWs = (Array.isArray(cfg.workspaces) ? cfg.workspaces : []) as Array<{ id: string; name: string; repo?: string; partition?: string }>;
	const workspaces = a.workspace ? allWs.filter((w) => w.id === a.workspace) : allWs;
	if (a.workspace && !workspaces.length) { d.err(`wcc-team: no workspace "${a.workspace}" — ${allWs.map((w) => w.id).join(', ')}`); return EXIT.usage; }
	const toolbars = (cfg.workspaceToolbars && typeof cfg.workspaceToolbars === 'object' ? cfg.workspaceToolbars : {}) as Record<string, { repo?: string; branch?: string }>;
	const roleLib = cfg.roleLibrary && typeof cfg.roleLibrary === 'object' ? (cfg.roleLibrary as { path?: string }).path : undefined;
	const vaultRoot = vaultRootOf(roleLib, (p) => fs.existsSync(p));
	const coordRoot = path.join(userData, '.coordination');
	const { names, reposByWorkspace } = readSessions(userData);
	const now = d.now();

	const calls: GitCall[] = [];
	const timedGit = (repoPath: string) => async (args: string[]) => {
		const s = d.clock();
		const r = await d.git(repoPath, args);
		calls.push({ repo: repoPath, args, ms: Math.round(d.clock() - s), code: r.code, bytes: r.stdout.length });
		return r;
	};
	// Git once per distinct repo, however many workspaces share it, all repos at once.
	const gitByPath = new Map<string, Promise<Sourced<GitFacts>>>();
	const listing = new Map<string, string[] | null>();
	const reports = await Promise.all(workspaces.map(async (w) => {
		const repo = projectRepo(w, repos, reposByWorkspace[w.id] ?? []);
		let git: Sourced<GitFacts>;
		if (!repo) git = { ok: false, reason: 'no repo — this workspace is not linked to one, no repo is named after it, and none of its saved terminals works in one' };
		else {
			const key = `${path.resolve(repo.path).toLowerCase()}\n${toolbars[w.id]?.branch ?? ''}`;
			if (!gitByPath.has(key)) gitByPath.set(key, gatherGit(repo, toolbars[w.id]?.branch, now, timedGit(repo.path)));
			git = await gitByPath.get(key)!;
		}
		const coordDir = path.join(coordRoot, w.id);
		const wsText = readText(path.join(coordDir, 'workstreams.jsonl'));
		const inputs: ProjectInputs = {
			now,
			workspace: { id: w.id, name: w.name, partition: w.partition === 'work' ? 'work' : 'personal' },
			repo: repo ? { name: repo.name, path: repo.path, from: repo.from } : null,
			git,
			vault: gatherVault(vaultRoot, new Set([projectKey(w.name), ...(repo ? [projectKey(repo.name)] : [])]), now, listing),
			floor: gatherFloor(coordRoot, w.id),
			workstreams: foldWorkstreams(wsText ?? ''),
			workstreamsRead: wsText !== null,
			attention: parseAttentionLog(readText(path.join(coordDir, 'attention.jsonl')) ?? ''),
			isolation: readIsolationLog(coordDir),
			proposals: foldProposals(readText(path.join(coordDir, 'spawn-proposals.jsonl')) ?? ''),
			names,
		};
		return buildProjectReport(inputs);
	}));

	for (const r of reports) for (const m of [...r.metrics, ...r.taskMetrics]) {
		if (!metricIsHonest(m)) { d.err(`wcc-team: internal error — metric ${m.id} in ${r.workspaceId} is neither a value nor a reason`); return EXIT.failed; }
	}
	const timing: Timing = {
		wallMs: Math.round(d.clock() - t0),
		processMs: Math.round(process.uptime() * 1000),
		workspaces: reports.length,
		repos: gitByPath.size,
		gitCalls: calls,
		gitMs: calls.reduce((s, c) => s + c.ms, 0),
	};
	const output: TeamMetricsOutput = { schema: 1, generatedAt: now, workspaces: reports, timing };
	if (a.json) d.out(JSON.stringify(output));
	else for (const r of reports) d.out(formatReport(r));
	d.err(formatTiming(timing));
	return EXIT.ok;
}

/** The plain-text rendering: value · label, then the source — or the reason in place of the value. */
export function formatReport(r: ProjectReport): string {
	const lines = [`${r.workspaceName} (${r.workspaceId}) · ${r.partition}${r.repo ? ` · ${r.repo.name} (from ${r.repo.from})` : ' · no repo'}`];
	for (const m of [...r.metrics, ...r.taskMetrics]) {
		lines.push(`  ${m.label}`);
		lines.push(m.value === null ? `    unavailable · ${m.unavailable}` : `    ${m.value}${m.unit ? ` ${m.unit}` : ''}`);
		lines.push(`    source: ${m.source} · ${m.freshness}`);
	}
	return lines.join('\n');
}

export function formatTiming(t: Timing): string {
	const head = `wcc-team: ${t.workspaces} workspace${t.workspaces === 1 ? '' : 's'}, ${t.repos} repo${t.repos === 1 ? '' : 's'} · wall ${t.wallMs} ms (process ${t.processMs} ms) · ${t.gitCalls.length} git call${t.gitCalls.length === 1 ? '' : 's'}, ${t.gitMs} ms summed`;
	return [head, ...t.gitCalls.map((c) => `  git -C ${c.repo} ${c.args.map((x) => (/[\s%]/.test(x) ? JSON.stringify(x) : x)).join(' ').slice(0, 140)} → ${c.code} · ${c.ms} ms · ${Math.round(c.bytes / 1024)} KB`)].join('\n');
}
