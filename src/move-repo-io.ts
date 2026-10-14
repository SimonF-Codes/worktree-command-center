import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from './command-runner';
import { snapshotProcesses } from './terminals/process-snapshot';
import { projectDirName } from './terminals/resume-target';
import { ensureWorktreesExcluded, WORKTREES_EXCLUDE } from './terminals/worktree-manager';
import type { RepoConfig } from './terminals/terminals-grid';
import {
	planMove, plannedDestinations, isInside, remapPath, parseWorktreePorcelain, parseGitmodulesPaths, gitdirOf, isAbsoluteGitdir,
	configPathRefs, type MoveFacts, type MovePlan, type WorktreeFact, type PathMove,
} from './move-repo';

// Moving a repo — the IO half. gatherMoveFacts reads everything planMove needs; executeMove runs
// a refusal-free plan step by step and verifies the result by reading it back. All the deciding
// is in move-repo.ts, where it is tested without moving a byte.

export const defaultProjectsDir = (): string => path.join(os.homedir(), '.claude', 'projects');

export interface GatherContext {
	/** Working directory of every live terminal, across every workspace. */
	livePaths: string[];
	/** Every registered target. */
	targets: RepoConfig[];
	/** The current config.json, scanned for other paths inside the repo. */
	config?: unknown;
	projectsDir?: string;
	/** Where executeMove keeps its journals: an unfinished run of this same move is read back, so
	 *  the plan knows which worktrees it already relocated. */
	journalDir?: string;
	caseInsensitive?: boolean;
	/** Probe the directories that would be renamed for a process holding them open (default on).
	 *  The probe IS a rename — in place and straight back — because that is the only test Windows
	 *  answers truthfully: a process's working directory holds the folder, and nothing that lists
	 *  processes can see a cwd. */
	probe?: boolean;
}

type Kind = MoveFacts['kind'];

const key = (p: string, ci: boolean): string => (ci ? path.resolve(p).toLowerCase() : path.resolve(p));

/** Worktree path → its admin dir (<repo>/.git/worktrees/<name>), from each admin dir's `gitdir`
 *  file, which names the worktree's own .git file. Read-only. */
function adminDirsByWorktree(repo: string, ci: boolean): Map<string, string> {
	const out = new Map<string, string>();
	const base = path.join(repo, '.git', 'worktrees');
	let names: string[] = [];
	try { names = fs.readdirSync(base); } catch { return out; }
	for (const n of names) {
		try {
			const dotGit = fs.readFileSync(path.join(base, n, 'gitdir'), 'utf8').trim();
			if (dotGit) out.set(key(path.dirname(dotGit), ci), path.join(base, n));
		} catch { /* not a worktree admin dir */ }
	}
	return out;
}

function kindAt(dir: string): Kind {
	if (!fs.existsSync(dir)) return 'missing';
	try {
		const st = fs.statSync(path.join(dir, '.git'));
		return st.isDirectory() ? 'repo' : 'worktree';
	} catch { return 'folder'; }
}

const firstLine = (r: { stderr: string; error?: string }): string => (r.error ?? r.stderr).trim().split('\n')[0] || 'failed';

/** Read the world. Throws only when git cannot list the repo's worktrees at all — without that
 *  list nothing about the move can be planned. Every other unreadable fact fails SAFE: a `git
 *  status` that errors counts as dirty, a probe that errors counts as held. */
export async function gatherMoveFacts(target: RepoConfig, to: string, ctx: GatherContext): Promise<MoveFacts> {
	const ci = ctx.caseInsensitive ?? process.platform === 'win32';
	const from = target.path;
	const fromExists = fs.existsSync(from), toExists = fs.existsSync(to);
	const here = !fromExists && toExists ? to : from;
	const kind = kindAt(here);
	const projectsDir = ctx.projectsDir ?? defaultProjectsDir();

	const facts: MoveFacts = {
		from, to, repoName: target.name, fromExists, toExists, kind, folderTarget: !!target.folder,
		worktrees: [], remotes: [], absoluteSubmodules: [], submoduleWorktrees: [], livePaths: ctx.livePaths, heldOpen: [],
		transcriptDirs: [], existing: [], targets: ctx.targets,
		configRefs: ctx.config ? configPathRefs(ctx.config, from, ci) : [], caseInsensitive: ci,
	};
	if (kind !== 'repo' || target.folder) return facts;
	if (ctx.journalDir) facts.priorRelocations = readOpenJournal(ctx.journalDir, from, to)?.relocations ?? [];

	const list = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: here, timeoutMs: 15000 });
	if (list.code !== 0) throw new Error(`git worktree list failed in ${here}: ${firstLine(list)}`);
	const listed = parseWorktreePorcelain(list.stdout);
	const resuming = here === to;
	const admin = resuming ? adminDirsByWorktree(here, ci) : new Map<string, string>();
	const worktrees: WorktreeFact[] = [];
	for (const w of listed) {
		// Where its files are now: a worktree nested in the repo moved with it, even though git
		// (not yet repaired) still lists it at the old path.
		const at = fs.existsSync(w.path) ? w.path
			: resuming && isInside(w.path, from, ci) ? remapPath(w.path, [{ from, to }], ci) : null;
		let dirty: string[] = [];
		if (at && fs.existsSync(at)) {
			let st = await runCommand('git', ['status', '--porcelain'], { cwd: at, timeoutMs: 15000 });
			// Resuming a move that stopped before its repair: the worktree's .git file still points
			// at the repo's OLD location, so plain git cannot find it. Ask through its admin dir
			// instead — read-only, and the repair is the plan's own next step.
			const adm = admin.get(key(w.path, ci));
			if (st.code !== 0 && adm) st = await runCommand('git', [`--git-dir=${adm}`, `--work-tree=${at}`, 'status', '--porcelain'], { cwd: at, timeoutMs: 15000 });
			dirty = st.code === 0
				? st.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
				: [`?? (git status failed, so this is treated as dirty: ${firstLine(st)})`];
		}
		worktrees.push({ ...w, dirty });
	}
	facts.worktrees = worktrees;

	const remotes = await runCommand('git', ['remote'], { cwd: here, timeoutMs: 8000 });
	facts.remotes = remotes.code === 0 ? remotes.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];

	for (const w of worktrees) {
		if (w.prunable || !fs.existsSync(w.path)) continue;
		let gm = '';
		try { gm = fs.readFileSync(path.join(w.path, '.gitmodules'), 'utf8'); } catch { continue; }
		for (const sub of parseGitmodulesPaths(gm)) {
			const dotGit = path.join(w.path, sub, '.git');
			if (!w.isMain && fs.existsSync(dotGit) && !facts.submoduleWorktrees!.includes(w.path)) facts.submoduleWorktrees!.push(w.path);
			let content: string;
			try { if (!fs.statSync(dotGit).isFile()) continue; content = fs.readFileSync(dotGit, 'utf8'); } catch { continue; }
			const gd = gitdirOf(content);
			if (gd && isAbsoluteGitdir(gd)) facts.absoluteSubmodules.push({ path: path.join(w.path, sub), gitdir: gd });
		}
	}

	try {
		facts.transcriptDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch { facts.transcriptDirs = []; }

	facts.existing = plannedDestinations(facts).filter((d) => fs.existsSync(d));

	// Probe last, and only a plan that would otherwise go ahead: a probe is a real rename, and
	// there is no reason to touch a directory for a move that is refused anyway.
	if (ctx.probe !== false) {
		const draft = planMove(facts);
		if (draft.refusals.length === 0) {
			const dirs = [...(draft.resuming || draft.relayout ? [] : [from]), ...draft.worktreeMoves.filter((m) => !m.done).map((m) => m.from)];
			const held: string[] = [];
			for (const d of dirs) if (await probeRename(d) === 'held') held.push(d);
			if (held.length) {
				const holders = await holdersByCommandLine(held);
				facts.heldOpen = held.map((d) => ({ path: d, holders: holders.get(d) ?? [] }));
			}
		}
	}
	return facts;
}

const HELD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Can `dir` be renamed right now? Renames it to a sibling and straight back.
 *
 *  'held' is the signature found on 2026-10-14: `git worktree move`, plain `mv` and a rename in
 *  place in the same parent ALL failed with Permission denied — a handle on the directory object
 *  itself, almost always a process whose cwd is inside. Failing the rename-in-place is what rules
 *  out the destination. Not retried: the condition is deterministic until the holder exits. */
export async function probeRename(dir: string): Promise<'free' | 'held' | 'absent'> {
	const probe = `${dir}.wcc-move-probe-${process.pid}`;
	try { fs.renameSync(dir, probe); } catch (e) {
		const code = (e as NodeJS.ErrnoException).code ?? '';
		if (code === 'ENOENT') return 'absent';
		if (HELD_CODES.has(code)) return 'held';
		throw e;
	}
	// Putting it back is the one step that must not fail; something could grab the probe name in
	// the instant it exists, so this — and only this — is retried.
	let last: unknown;
	for (let i = 0; i < 10; i++) {
		try { fs.renameSync(probe, dir); return 'free'; } catch (e) { last = e; await sleep(100 * (i + 1)); }
	}
	throw new Error(`The held-open probe renamed ${dir} to ${probe} and could NOT rename it back (${(last as Error).message}). Rename it back by hand before doing anything else.`);
}

/** Name the processes whose COMMAND LINE mentions a held directory. Finds some holders, not all —
 *  a shell that merely has its cwd there does not mention it — so an empty answer is not "none". */
async function holdersByCommandLine(dirs: string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	const rows = await snapshotProcesses({ withCommandLine: true });
	for (const d of dirs) {
		const needles = [d.toLowerCase(), d.replace(/\\/g, '/').toLowerCase()];
		const hits = rows.filter((r) => r.cmd && needles.some((n) => r.cmd!.toLowerCase().includes(n)) && r.pid !== process.pid);
		if (hits.length) out.set(d, hits.map((r) => `${r.name} (pid ${r.pid})`));
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Executing

export interface MoveStep { label: string; ok: boolean; detail?: string }

export interface VerifyResult {
	ok: boolean;
	/** Distinct commit SHAs recorded before the move. */
	shas: number;
	missingShas: string[];
	/** Refs whose SHA changed or that vanished. */
	changedRefs: string[];
	/** Expected worktrees that git does not list, or lists as prunable. */
	brokenWorktrees: string[];
}

export interface MoveResult {
	ok: boolean;
	steps: MoveStep[];
	/** The step that failed — where a re-run picks up. */
	stoppedAt?: string;
	verify?: VerifyResult;
	journal: string;
}

export interface ExecuteDeps {
	projectsDir?: string;
	/** Where the move's journal (the pre-move refs) is kept, so a resumed run still verifies
	 *  against what existed before the FIRST attempt. */
	journalDir: string;
	/** Repoint config.json (target, linked tabs) and the sessions file with plan.pathMap, in the
	 *  running app, and read it back. The app has to do this itself: persist() rewrites the whole
	 *  `repos` key from memory, so an edit from outside is overwritten. */
	applyAppState: (plan: MovePlan) => Promise<{ ok: boolean; detail: string }>;
}

interface Journal {
	from: string; to: string; startedAt: string; refs: Record<string, string>; heads: string[];
	/** The worktree relocations the first attempt planned — how a resumed run recognises one it
	 *  finished, now that a relocated worktree and a native one both sit inside the repo. */
	relocations?: PathMove[];
	completedAt?: string;
}

const journalPath = (journalDir: string, from: string): string => path.join(journalDir, `${projectDirName(path.resolve(from))}.json`);

/** The journal of an earlier, UNFINISHED attempt at this same move (same from, same to), or null. */
function readOpenJournal(journalDir: string, from: string, to: string): Journal | null {
	try {
		const j = JSON.parse(fs.readFileSync(journalPath(journalDir, from), 'utf8')) as Journal;
		return path.resolve(j.to) === path.resolve(to) && !j.completedAt ? j : null;
	} catch { return null; }
}

/** `<sha> <ref>` for every ref, plus the HEAD of every worktree (a detached HEAD is a commit no
 *  ref names). */
async function snapshotRefs(repo: string): Promise<{ refs: Record<string, string>; heads: string[] } | string> {
	const r = await runCommand('git', ['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: repo, timeoutMs: 15000 });
	if (r.code !== 0) return firstLine(r);
	const refs: Record<string, string> = {};
	for (const line of r.stdout.split('\n')) {
		const m = /^([0-9a-f]{7,64}) (.+?)\r?$/.exec(line);
		if (m) refs[m[2]!] = m[1]!;
	}
	const wl = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repo, timeoutMs: 15000 });
	const heads = wl.code === 0 ? [...wl.stdout.matchAll(/^HEAD ([0-9a-f]{7,64})\r?$/gm)].map((m) => m[1]!) : [];
	return { refs, heads };
}

/** Run a plan. Refuses a plan with refusals. Stops at the first failing step and says which —
 *  every step is either atomic (a rename, `git worktree move`) or idempotent (`repair`, the config
 *  edit), so the state it stops in is one planMove replans from, and re-running finishes it. */
export async function executeMove(plan: MovePlan, deps: ExecuteDeps): Promise<MoveResult> {
	const projectsDir = deps.projectsDir ?? defaultProjectsDir();
	const journal = journalPath(deps.journalDir, plan.from);
	const steps: MoveStep[] = [];
	const stop = (label: string, detail: string): MoveResult => {
		steps.push({ label, ok: false, detail });
		return { ok: false, steps, stoppedAt: label, journal };
	};
	if (plan.refusals.length) return stop('Pre-flight', `The plan has ${plan.refusals.length} refusal(s); nothing was done.`);

	// --- 0. what exists before: from the journal of an earlier attempt at THIS move, else now.
	let before = readOpenJournal(deps.journalDir, plan.from, plan.to);
	if (!before) {
		const snap = await snapshotRefs(plan.resuming ? plan.to : plan.from);
		if (typeof snap === 'string') return stop('Recording refs before the move', snap);
		before = { from: plan.from, to: plan.to, startedAt: new Date().toISOString(), ...snap, relocations: plan.worktreeMoves.map((m) => ({ from: m.from, to: m.to })) };
		try { fs.mkdirSync(deps.journalDir, { recursive: true }); fs.writeFileSync(journal, JSON.stringify(before, null, 2), 'utf8'); }
		catch (e) { return stop('Writing the move journal', (e as Error).message); }
		steps.push({ label: `Recorded ${Object.keys(before.refs).length} refs`, ok: true, detail: plan.resuming ? 'resumed without a journal: recorded from the state the earlier run left' : journal });
	} else {
		steps.push({ label: `Resuming — verifying against the ${Object.keys(before.refs).length} refs recorded ${before.startedAt}`, ok: true });
	}

	// --- 1. the repo directory (a relayout leaves it where it is)
	if (!plan.resuming && !plan.relayout) {
		const label = `Moving ${plan.from} → ${plan.to}`;
		try {
			fs.mkdirSync(path.dirname(plan.to), { recursive: true });
			fs.renameSync(plan.from, plan.to);
		} catch (e) { return stop(label, (e as Error).message); }
		steps.push({ label, ok: true });
	}

	// --- 2. both ends of every worktree link, in one pass. A relayout moves only worktrees, and
	// `git worktree move` rewrites both ends of each itself.
	if (!plan.relayout) {
		const label = `git worktree repair (${plan.repair.length} worktree${plan.repair.length === 1 ? '' : 's'})`;
		const r = await runCommand('git', ['worktree', 'repair', ...plan.repair], { cwd: plan.to, timeoutMs: 30000 });
		if (r.code !== 0) return stop(label, firstLine(r));
		steps.push({ label, ok: true });
	}

	// --- 3. worktrees into the repo. Excluded from git FIRST, so at no moment does the repo's own
	// checkout show them as untracked (which reads as dirty, and would refuse the next Move).
	if (plan.worktreeMoves.some((m) => !m.done)) {
		const label = `Excluding ${WORKTREES_EXCLUDE} from git in ${plan.to} (.git/info/exclude)`;
		try { await ensureWorktreesExcluded(plan.to); } catch (e) { return stop(label, (e as Error).message); }
		steps.push({ label, ok: true });
	}
	for (const m of plan.worktreeMoves.filter((x) => !x.done)) {
		const label = `git worktree move ${m.from} → ${m.to}`;
		try { fs.mkdirSync(path.dirname(m.to), { recursive: true }); } catch (e) { return stop(label, (e as Error).message); }
		const r = await runCommand('git', ['worktree', 'move', m.from, m.to], { cwd: plan.to, timeoutMs: 60000 });
		if (r.code !== 0) return stop(label, firstLine(r));
		steps.push({ label, ok: true });
	}

	// --- 4. transcripts, so Reopen still finds each conversation
	for (const t of plan.transcripts.filter((x) => !x.done)) {
		const label = `Renaming transcript ${t.from} → ${t.to}`;
		try { fs.renameSync(path.join(projectsDir, t.from), path.join(projectsDir, t.to)); }
		catch (e) { return stop(label, (e as Error).message); }
		steps.push({ label, ok: true });
	}

	// --- 5. config.json and the sessions file, in-process, read back
	{
		const label = 'Repointing config.json and saved terminals';
		let r: { ok: boolean; detail: string };
		try { r = await deps.applyAppState(plan); } catch (e) { r = { ok: false, detail: (e as Error).message }; }
		if (!r.ok) return stop(label, r.detail);
		steps.push({ label, ok: true, detail: r.detail });
	}

	// --- 6. the old worktree root, if the move emptied it. rmdir, never rm: it only ever
	// removes an EMPTY folder, so anything left behind (a worktree that stayed) keeps it.
	// The shared root above it goes too once the last repo has left it.
	if (plan.worktreeMoves.length) {
		for (const dir of [plan.oldWorktreeRoot, path.dirname(plan.oldWorktreeRoot)]) {
			try { fs.rmdirSync(dir); steps.push({ label: `Removed the empty ${dir}`, ok: true }); }
			catch { break; /* not empty, or already gone — either is fine */ }
		}
	}

	// --- 7. verify by reading back
	const verify = await verifyMove(plan, before);
	steps.push({
		label: 'Verifying',
		ok: verify.ok,
		detail: verify.ok
			? `all ${verify.shas} commits present, every ref unchanged, all ${plan.expectedWorktrees.length} worktrees resolve`
			: [
				verify.missingShas.length ? `MISSING commits: ${verify.missingShas.join(', ')}` : '',
				verify.changedRefs.length ? `changed refs: ${verify.changedRefs.join(', ')}` : '',
				verify.brokenWorktrees.length ? `worktrees not resolving: ${verify.brokenWorktrees.join(', ')}` : '',
			].filter(Boolean).join('; '),
	});
	if (!verify.ok) return { ok: false, steps, stoppedAt: 'Verifying', verify, journal };
	try { fs.writeFileSync(journal, JSON.stringify({ ...before, completedAt: new Date().toISOString() }, null, 2), 'utf8'); } catch { /* the move itself is done */ }
	return { ok: true, steps, verify, journal };
}

/** Every pre-move commit still present (`git cat-file -t`, args as an array — a `^{commit}`
 *  through cmd.exe is how a verification once reported 0 of 12 present when all 12 were), every
 *  ref byte-identical, and every expected worktree listed and not prunable. */
export async function verifyMove(plan: MovePlan, before: { refs: Record<string, string>; heads: string[] }): Promise<VerifyResult> {
	const shas = [...new Set([...Object.values(before.refs), ...before.heads])];
	const missingShas: string[] = [];
	for (const sha of shas) {
		const r = await runCommand('git', ['cat-file', '-t', sha], { cwd: plan.to, timeoutMs: 8000 });
		if (r.code !== 0) missingShas.push(sha);
	}
	const after = await snapshotRefs(plan.to);
	const changedRefs = typeof after === 'string'
		? ['(could not list refs after the move)']
		: Object.entries(before.refs).filter(([ref, sha]) => after.refs[ref] !== sha).map(([ref]) => ref);
	const brokenWorktrees: string[] = [];
	const wl = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: plan.to, timeoutMs: 15000 });
	const listed = wl.code === 0 ? parseWorktreePorcelain(wl.stdout) : [];
	for (const want of plan.expectedWorktrees) {
		const w = listed.find((l) => path.resolve(l.path).toLowerCase() === path.resolve(want).toLowerCase());
		if (!w || w.prunable || !fs.existsSync(want)) brokenWorktrees.push(want);
	}
	return { ok: !missingShas.length && !changedRefs.length && !brokenWorktrees.length, shas: shas.length, missingShas, changedRefs, brokenWorktrees };
}

/** The result as one block of text: every step, ✓ or ✗, and — on a failure — what to do next. */
export function describeMoveResult(r: MoveResult): string {
	const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.label}${s.detail ? `\n    ${s.detail}` : ''}`);
	if (!r.ok) {
		lines.push('');
		lines.push(`Stopped at: ${r.stoppedAt}. Everything before it is done; nothing after it was attempted. Fix the cause and run Move again with the same destination — it picks up from here.`);
	}
	return lines.join('\n');
}
