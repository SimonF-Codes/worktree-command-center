import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planPrune, describePrunePlan, stillPrunable, type PrunePlan } from '../prune-worktrees';
import { gatherPruneFacts, executePrune, describePruneResults, type PruneGatherContext } from '../prune-worktrees-io';
import { planMove, describeMovePlan, describeRefusals, remapSessionRecords, remapRepoLinks, samePath, type MovePlan, type PathedRecord } from '../move-repo';
import { gatherMoveFacts, executeMove, describeMoveResult, defaultProjectsDir, probeRenameCode } from '../move-repo-io';
import { WORKTREES_EXCLUDE } from '../terminals/worktree-manager';
import type { RepoConfig } from '../terminals/terminals-grid';
import { appIsRunning, APP_RUNNING_REASON } from './app-guard';
import { diagnose, realDiagnoseDeps, type DiagnoseDeps } from './hold-diagnosis';

// wcc-worktrees — the command line for the two worktree jobs that otherwise live behind buttons
// in ⚙ Settings → Targets: pruning merged worktrees, and the relayout that nests a repo's
// worktrees inside it. A thin front end: every decision is made by the SAME modules the app uses
// (prune-worktrees.ts, move-repo.ts and their -io halves); this file only finds the targets,
// reads the app's files, prints, and writes the two files the app would otherwise write itself.
//
// Dry run by default. --apply refuses while the app is running (app-guard.ts says why).

export const EXIT = { ok: 0, failed: 1, refused: 2, usage: 64 } as const;

export interface CliDeps {
	out: (s: string) => void;
	err: (s: string) => void;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	appRunning: () => boolean;
	diagnoseDeps: DiagnoseDeps;
}

const USAGE = `usage: wcc-worktrees <prune|relayout> [<repo>] [--apply] [--no-probe]
                     [--user-data <dir>] [--projects-dir <dir>]

  prune [<repo>]     Which worktrees are merged and clean enough to remove — and for each one
                     kept, every reason; for each, how many Claude conversations removing it
                     would orphan. Branches are never deleted.
  relayout [<repo>]  Move a repo's worktrees out of the old shared root
                     (<parent>/.claude-worktrees/<repo>) into <repo>/.claude-worktrees, with
                     their transcripts, saved terminals and the .git/info/exclude line.

  <repo>             A target's name or path from config.json. Default: every repo target.
  --apply            Do it. Without it, nothing is written (a dry run).
  --no-probe         Skip the held-open probe (a rename of each candidate in place and back).
  --user-data <dir>  The app's data folder (default %APPDATA%/worktree-command-center; or
                     WCC_USER_DATA).
  --projects-dir <dir>  Claude's transcript folder (default ~/.claude/projects).

Exit: 0 done or nothing to do · 1 failed · 2 refused · 64 usage.`;

interface Args { cmd: 'prune' | 'relayout'; repo?: string; apply: boolean; probe: boolean; userData?: string; projectsDir?: string }

export function parseArgs(argv: readonly string[]): Args | string {
	const [cmd, ...rest] = argv;
	if (cmd !== 'prune' && cmd !== 'relayout') return cmd ? `unknown command "${cmd}"` : 'no command';
	const a: Args = { cmd, apply: false, probe: true };
	for (let i = 0; i < rest.length; i++) {
		const x = rest[i]!;
		if (x === '--apply') a.apply = true;
		else if (x === '--no-probe') a.probe = false;
		else if (x === '--user-data' || x === '--projects-dir') {
			const v = rest[++i];
			if (!v) return `${x} needs a directory`;
			if (x === '--user-data') a.userData = v; else a.projectsDir = v;
		} else if (x.startsWith('-')) return `unknown option ${x}`;
		else if (a.repo) return `one repo at a time (got "${a.repo}" and "${x}")`;
		else a.repo = x;
	}
	return a;
}

/** Where Electron keeps the app's data: app.getPath('userData') for the name in package.json. */
export function defaultUserData(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (env.WCC_USER_DATA) return env.WCC_USER_DATA;
	const name = 'worktree-command-center';
	if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
	if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
	return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

class Refused extends Error {}

/** The targets a command acts on: the one named (by name or path), or every repo target. */
export function selectTargets(repos: readonly RepoConfig[], arg: string | undefined, ci: boolean): RepoConfig[] {
	if (!arg) return repos.filter((r) => !r.folder);
	const hit = repos.find((r) => (ci ? r.name.toLowerCase() === arg.toLowerCase() : r.name === arg))
		?? (path.isAbsolute(arg) ? repos.find((r) => samePath(r.path, arg, ci)) : undefined);
	if (!hit) throw new Refused(`no repo target "${arg}" in config.json. Targets: ${repos.map((r) => r.name).join(', ') || '(none)'}`);
	if (hit.folder) throw new Refused(`"${hit.name}" is a folder target, not a git repo — it has no worktrees`);
	return [hit];
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write through a temp file and a rename, so a crash never leaves half a file. */
function writeJsonAtomic(file: string, v: unknown): void {
	const tmp = `${file}.wcc-worktrees-${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
	fs.renameSync(tmp, file);
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);

export async function main(argv: readonly string[], partial: Partial<CliDeps> = {}): Promise<number> {
	const d: CliDeps = {
		out: (s) => process.stdout.write(`${s}\n`),
		err: (s) => process.stderr.write(`${s}\n`),
		env: process.env,
		platform: process.platform,
		appRunning: () => appIsRunning(),
		diagnoseDeps: realDiagnoseDeps(),
		...partial,
	};
	if (argv.includes('-h') || argv.includes('--help')) { d.out(USAGE); return EXIT.ok; }
	const a = parseArgs(argv);
	if (typeof a === 'string') { d.err(`wcc-worktrees: ${a}\n\n${USAGE}`); return EXIT.usage; }

	const ci = d.platform === 'win32';
	const userData = a.userData ?? defaultUserData(d.env, d.platform);
	const projectsDir = a.projectsDir ?? defaultProjectsDir();
	const configFile = path.join(userData, 'config.json');
	const sessionsFile = path.join(userData, '.terminal-sessions.json');
	const refuse = (why: string): number => { d.err(`wcc-worktrees: REFUSING — ${why}`); return EXIT.refused; };

	let cfg: Record<string, unknown>;
	try { cfg = readJson(configFile) as Record<string, unknown>; }
	catch (e) { d.err(`wcc-worktrees: cannot read ${configFile}: ${(e as Error).message}`); return EXIT.failed; }
	const repos: RepoConfig[] = Array.isArray(cfg.repos) ? (cfg.repos as RepoConfig[]) : [];
	let targets: RepoConfig[];
	try { targets = selectTargets(repos, a.repo, ci); }
	catch (e) { if (e instanceof Refused) return refuse(e.message); throw e; }

	const running = d.appRunning();
	if (a.apply && running) return refuse(APP_RUNNING_REASON);
	const env = { ...d, ci, userData, projectsDir, configFile, sessionsFile, running, refuse };
	return a.cmd === 'prune' ? prune(a, targets, env) : relayout(a, targets, repos, env);
}

interface Env extends CliDeps { ci: boolean; userData: string; projectsDir: string; configFile: string; sessionsFile: string; running: boolean; refuse: (why: string) => number }

// ---------------------------------------------------------------------------------------------
// prune

async function prune(a: Args, targets: RepoConfig[], e: Env): Promise<number> {
	if (e.running) e.err('wcc-worktrees: note — the app is running, and which terminals it has open cannot be seen from here, so every worktree is kept as "live-unknown" (the merged/clean verdicts below are still real). Close the app for a dry run that can say yes.');
	const ctx: PruneGatherContext = {
		// Closed app → no app terminal is running anywhere; a non-app process inside a worktree is
		// what the held-open probe is for.
		livePaths: e.running ? null : [],
		sessionsFile: e.sessionsFile, projectsDir: e.projectsDir, caseInsensitive: e.ci, probe: a.probe,
	};
	const gather = async (): Promise<PrunePlan> => planPrune(await gatherPruneFacts(targets.map((t) => ({ name: t.name, path: t.path })), ctx));
	const plan = await gather();
	e.out(describePrunePlan(plan));
	await printHeldDiagnoses(plan, e);
	const unreadable = plan.repos.filter((r) => r.error).length;
	const status = unreadable ? EXIT.failed : EXIT.ok;
	if (!a.apply) {
		e.out(`\nDry run — nothing was removed.${plan.totals.prune ? ' Re-run with --apply to remove the ✓ lines.' : ''}`);
		return status;
	}
	if (!plan.totals.prune) { e.out('\nNothing to prune.'); return status; }

	// Right before removing, a fresh look — only what it still agrees on goes (as the app does).
	if (e.appRunning()) return e.refuse(`${APP_RUNNING_REASON} (It was started after the dry run; nothing was removed.)`);
	const confirmed = stillPrunable(plan, await gather(), e.ci);
	const results = await executePrune(confirmed);
	e.out('');
	e.out(describePruneResults(results, plan));
	const dropped = plan.totals.prune - results.length;
	if (dropped) e.out(`${dropped} changed between the plan and the removal and ${dropped === 1 ? 'was' : 'were'} left alone.`);
	for (const r of results.filter((x) => !x.ok)) {
		const dg = await diagnose(r.detail, r.path, null, e.diagnoseDeps);
		if (dg.mode) e.err(`  ${path.basename(r.path)}: failure mode ${dg.mode} — ${dg.message}`);
	}
	return results.every((r) => r.ok) ? status : EXIT.failed;
}

/** For each worktree kept because it is held open: which of the hold kinds it is. */
async function printHeldDiagnoses(plan: PrunePlan, e: Env): Promise<void> {
	for (const r of plan.repos) {
		for (const k of r.keep) {
			if (!k.refusals.some((x) => x.code === 'held-open')) continue;
			const code = await probeRenameCode(k.path).catch(() => 'EPERM' as const);
			if (code === 'free' || code === 'absent') { e.out(`  ↳ ${k.path} is free now — re-run.`); continue; }
			const dg = await diagnose(code, k.path, null, e.diagnoseDeps);
			e.out(`  ↳ ${dg.mode ? `failure mode ${dg.mode}: ` : ''}${dg.message}`);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// relayout

async function relayout(a: Args, targets: RepoConfig[], repos: RepoConfig[], e: Env): Promise<number> {
	if (e.running) e.err('wcc-worktrees: note — the app is running, so its live terminals cannot be seen from here and are not checked in this dry run. --apply refuses until it is closed.');
	const journalDir = path.join(e.userData, 'repo-moves');
	let status: number = EXIT.ok;
	for (const t of targets) {
		let cfg: unknown;
		try { cfg = readJson(e.configFile); } catch { cfg = undefined; }
		let plan: MovePlan;
		try {
			plan = planMove(await gatherMoveFacts(t, t.path, { livePaths: [], targets: repos, config: cfg, projectsDir: e.projectsDir, journalDir, caseInsensitive: e.ci, probe: a.probe }));
		} catch (err) {
			e.err(`wcc-worktrees: ${t.name}: could not be read — ${(err as Error).message}`);
			status = EXIT.failed;
			continue;
		}
		if (plan.refusals.length && plan.refusals.every((r) => r.code === 'nothing-to-relayout')) {
			e.out(`${t.name}: nothing to relayout — ${plan.refusals[0]!.message}`);
			continue;
		}
		e.out(`\n== ${t.name} — relayout ${a.apply ? '' : '(dry run)'}`.trimEnd());
		e.out(describeMovePlan(plan));
		e.out('');
		e.out(describeRelayoutDetail(plan, e));
		if (plan.refusals.length) {
			e.err(`\nwcc-worktrees: REFUSING ${t.name} — ${plan.refusals.length} reason${plan.refusals.length === 1 ? '' : 's'}:`);
			e.err(describeRefusals(plan));
			for (const r of plan.refusals.filter((x) => x.code === 'held-open' && x.path)) {
				const code = await probeRenameCode(r.path!).catch(() => 'EPERM' as const);
				if (code === 'free' || code === 'absent') continue;
				const m = plan.worktreeMoves.find((w) => samePath(w.from, r.path!, e.ci));
				const dg = await diagnose(code, r.path!, m?.to ?? null, e.diagnoseDeps);
				e.err(`  ↳ ${dg.mode ? `failure mode ${dg.mode}: ` : ''}${dg.message}`);
			}
			status = EXIT.refused;
			continue;
		}
		if (!a.apply) { e.out(`\nDry run — nothing was moved. Re-run with --apply to do it.`); continue; }

		const result = await executeMove(plan, { journalDir, projectsDir: e.projectsDir, applyAppState: (p) => applyFiles(p, e) });
		e.out('');
		e.out(describeMoveResult(result).replace(/run Move again with the same destination/, `re-run \`wcc-worktrees relayout ${t.name} --apply\``));
		if (!result.ok) {
			const failed = result.steps.find((s) => !s.ok);
			const m = plan.worktreeMoves.find((w) => result.stoppedAt?.includes(w.from));
			const tr = plan.transcripts.find((x) => result.stoppedAt?.includes(x.from));
			const dir = m?.from ?? (tr ? path.join(e.projectsDir, tr.from) : null);
			if (failed?.detail && dir) {
				const dg = await diagnose(failed.detail, dir, m?.to ?? (tr ? path.join(e.projectsDir, tr.to) : null), e.diagnoseDeps);
				e.err(`wcc-worktrees: ${t.name} stopped — ${dg.mode ? `failure mode ${dg.mode}: ` : ''}${dg.message}`);
			} else {
				e.err(`wcc-worktrees: ${t.name} stopped at: ${result.stoppedAt}${failed?.detail ? ` — ${failed.detail}` : ''}`);
			}
			return EXIT.failed; // the next repo waits until this one is finished
		}
	}
	return status;
}

/** Everything describeMovePlan summarises, spelt out in full: each directory and transcript
 *  folder by its whole path, the exclude file and line, and every record in the sessions file
 *  and config.json the path map rewrites. Read-only. */
export function describeRelayoutDetail(plan: MovePlan, e: Pick<Env, 'ci' | 'projectsDir' | 'sessionsFile' | 'configFile'>): string {
	const lines: string[] = [];
	const todo = plan.worktreeMoves.filter((m) => !m.done);
	lines.push(`Directory moves (git worktree move — rewrites both ends of the link; the parent is created first): ${todo.length}`);
	for (const m of plan.worktreeMoves) lines.push(`  ${m.from}\n    → ${m.to}${m.done ? '   ✓ already' : ''}`);

	const exclude = path.join(plan.to, '.git', 'info', 'exclude');
	let has = false;
	try { has = fs.readFileSync(exclude, 'utf8').split('\n').some((l) => l.trim() === WORKTREES_EXCLUDE); } catch { /* not there yet */ }
	lines.push(`Exclude: ${exclude}\n  ${has ? `already has ${WORKTREES_EXCLUDE}` : `+ ${WORKTREES_EXCLUDE}`}`);

	lines.push(`Transcript folders renamed (${e.projectsDir}): ${plan.transcripts.filter((t) => !t.done).length}`);
	for (const t of plan.transcripts) {
		let n = 0;
		try { n = fs.readdirSync(path.join(e.projectsDir, t.done ? t.to : t.from)).filter((f) => f.endsWith('.jsonl')).length; } catch { /* counted as 0 */ }
		lines.push(`  ${t.from}\n    → ${t.to}   (${n} conversation${n === 1 ? '' : 's'})${t.done ? '   ✓ already' : ''}`);
	}

	let all: Record<string, PathedRecord[]> | null = null;
	try { all = readJson(e.sessionsFile) as Record<string, PathedRecord[]>; } catch { /* none */ }
	if (!all) lines.push(`Saved terminals (${e.sessionsFile}): unreadable or absent — nothing to rewrite`);
	else {
		const changes = sessionChanges(all, plan, e.ci);
		lines.push(`Saved terminal records rewritten (${e.sessionsFile}): ${changes.length}`);
		lines.push(...changes.map((c) => `  ${c}`));
	}

	let cfg: Record<string, unknown> = {};
	try { cfg = readJson(e.configFile) as Record<string, unknown>; } catch { /* none */ }
	const tabs = configChanges(cfg, plan, e.ci).changed;
	lines.push(`config.json tab links rewritten: ${tabs.length}${tabs.length ? '' : ' (the repo itself does not move)'}`);
	lines.push(...tabs.map((c) => `  ${c}`));
	return lines.join('\n');
}

function sessionChanges(all: Record<string, PathedRecord[]>, plan: MovePlan, ci: boolean): string[] {
	const out: string[] = [];
	const after = remapSessionRecords(all, plan.pathMap, ci).all;
	for (const [k, recs] of Object.entries(all)) {
		if (!Array.isArray(recs)) continue;
		recs.forEach((r, i) => {
			const n = after[k]![i]!;
			const name = (r as { name?: string }).name;
			if (n.worktreePath !== r.worktreePath) out.push(`[${k}]${name ? ` ${name}` : ''} worktreePath ${r.worktreePath}\n    → ${n.worktreePath}`);
			if (n.repoPath !== r.repoPath) out.push(`[${k}]${name ? ` ${name}` : ''} repoPath ${r.repoPath}\n    → ${n.repoPath}`);
		});
	}
	return out;
}

/** The tabs (and closed tabs' tombstones) linked to a path the map moves — the same rewrite the
 *  app's applyPathMap does. A relayout leaves the repo where it is, so normally none. */
function configChanges(cfg: Record<string, unknown>, plan: MovePlan, ci: boolean): { cfg: Record<string, unknown>; changed: string[] } {
	const changed: string[] = [];
	const next = { ...cfg };
	for (const key of ['workspaces', 'closedWorkspaces']) {
		const list = cfg[key];
		if (!Array.isArray(list)) continue;
		const mapped = remapRepoLinks(list as { repo?: string; id?: string }[], plan.pathMap, ci);
		mapped.forEach((w, i) => { if (w !== list[i]) changed.push(`${key}[${w.id ?? i}].repo ${(list[i] as { repo?: string }).repo} → ${w.repo}`); });
		next[key] = mapped;
	}
	return { cfg: next, changed };
}

/** executeMove's last write: what the app's applyPathMap does in-process, done on the files —
 *  safe only because the app is closed, which is checked AGAIN here (it could have been started
 *  while the worktrees were moving; then this stops, and a re-run picks up from here). Each file
 *  is backed up before it is written and read back after. */
function applyFiles(plan: MovePlan, e: Env): Promise<{ ok: boolean; detail: string }> {
	if (e.appRunning()) return Promise.resolve({ ok: false, detail: `the app is running now — ${APP_RUNNING_REASON}` });
	const notes: string[] = [];
	try {
		let all: Record<string, PathedRecord[]> | null = null;
		try { all = readJson(e.sessionsFile) as Record<string, PathedRecord[]>; }
		catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${e.sessionsFile} is unreadable: ${(err as Error).message}`); }
		if (!all) notes.push('no saved-terminals file');
		else {
			const r = remapSessionRecords(all, plan.pathMap, e.ci);
			if (r.changed) {
				fs.copyFileSync(e.sessionsFile, `${e.sessionsFile}.bak-${stamp()}`);
				writeJsonAtomic(e.sessionsFile, r.all);
				const back = remapSessionRecords(readJson(e.sessionsFile) as Record<string, PathedRecord[]>, plan.pathMap, e.ci);
				if (back.changed) return Promise.resolve({ ok: false, detail: `${e.sessionsFile} still has ${back.changed} record(s) at the old paths after writing it` });
			}
			notes.push(`${r.changed} saved terminal record${r.changed === 1 ? '' : 's'} rewritten`);
		}
		const cfg = readJson(e.configFile) as Record<string, unknown>;
		const c = configChanges(cfg, plan, e.ci);
		if (c.changed.length) {
			fs.copyFileSync(e.configFile, `${e.configFile}.bak-${stamp()}`);
			writeJsonAtomic(e.configFile, c.cfg);
			if (configChanges(readJson(e.configFile) as Record<string, unknown>, plan, e.ci).changed.length) return Promise.resolve({ ok: false, detail: 'config.json still links tabs to the old paths after writing it' });
		}
		notes.push(`${c.changed.length} config.json tab link${c.changed.length === 1 ? '' : 's'} rewritten`);
	} catch (err) {
		return Promise.resolve({ ok: false, detail: (err as Error).message });
	}
	return Promise.resolve({ ok: true, detail: notes.join('; ') });
}
