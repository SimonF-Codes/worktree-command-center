import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import * as esbuild from 'esbuild';
import { main, parseArgs, selectTargets, EXIT, type CliDeps } from '../src/cli/worktrees-cli';
import { appIsRunning, tasklistShows, psShows, imageStem, APP_IMAGE } from '../src/cli/app-guard';
import { diagnose, errorKind, parseCwdHolderOutput, realDiagnoseDeps, type DiagnoseDeps } from '../src/cli/hold-diagnosis';
import { projectDirName } from '../src/terminals/resume-target';

// Real git, real directories, all inside a temp root — never a live worktree. The fixture is the
// apartment-planner shape the brief names as the pilot: a repo with its worktrees in the old
// shared root beside it (<parent>/.claude-worktrees/apartment-planner), wt-main-2 on wt/main-2
// three commits ahead of main and unmatched by git cherry, one transcript folder with one
// conversation, and its saved terminal under the apartment-planner workspace. Plus wt-main-1,
// fully merged, so prune has something it may remove.

const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const win = process.platform === 'win32';

let root: string, repo: string, oldRoot: string, wt1: string, wt2: string, projects: string, userData: string, sessionsFile: string, configFile: string;
const nested = (wt: string) => path.join(repo, '.claude-worktrees', path.basename(wt));
const t2 = () => projectDirName(wt2);

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-worktrees-cli-')));
	repo = path.join(root, 'dev', 'apartment-planner');
	oldRoot = path.join(root, 'dev', '.claude-worktrees', 'apartment-planner');
	wt1 = path.join(oldRoot, 'wt-main-1');
	wt2 = path.join(oldRoot, 'wt-main-2');
	projects = path.join(root, 'projects');
	userData = path.join(root, 'userData');
	sessionsFile = path.join(userData, '.terminal-sessions.json');
	configFile = path.join(userData, 'config.json');

	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 't@t');
	git(repo, 'config', 'user.name', 't');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
	fs.mkdirSync(oldRoot, { recursive: true });
	git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-1', wt1, 'main');
	git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-2', wt2, 'main');
	for (let i = 1; i <= 3; i++) {
		fs.writeFileSync(path.join(wt2, `f${i}.txt`), `${i}\n`);
		git(wt2, 'add', '-A');
		git(wt2, 'commit', '-q', '-m', `work ${i}`);
	}

	fs.mkdirSync(path.join(projects, t2()), { recursive: true });
	fs.writeFileSync(path.join(projects, t2(), 's1.jsonl'), '{}\n');
	fs.mkdirSync(userData, { recursive: true });
	fs.writeFileSync(configFile, JSON.stringify({ repos: [{ name: 'apartment-planner', path: repo }], workspaces: [{ id: 'apartment-planner', name: 'apartment-planner', repo }] }, null, 2));
	fs.writeFileSync(sessionsFile, JSON.stringify({
		'apartment-planner': [{ worktreePath: wt2, branch: 'wt/main-2', repoName: 'apartment-planner', repoPath: repo, baseBranch: 'main', name: 'wt-main-2' }],
	}, null, 2));
});

const children: ChildProcess[] = [];
afterEach(async () => {
	for (const c of children.splice(0)) await release(c);
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function holdOpen(cwd: string): Promise<ChildProcess> {
	const c = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
	children.push(c);
	await new Promise<void>((res, rej) => { c.stdout!.once('data', () => res()); c.once('error', rej); c.once('exit', () => rej(new Error('holder exited early'))); });
	return c;
}
async function release(c: ChildProcess): Promise<void> {
	if (c.exitCode !== null || c.signalCode !== null) return;
	await new Promise<void>((res) => { c.once('exit', () => res()); c.kill(); });
}

const noDiagnose: DiagnoseDeps = { findCwdHolders: async () => null, contentsWritable: () => null, syncRoots: [] };

/** Run the CLI in-process against the fixture. `running` is the app guard's answer — a function so
 *  a test can have the app start mid-run. */
async function run(args: string[], running: boolean | (() => boolean) = false, over: Partial<CliDeps> = {}) {
	const out: string[] = [], err: string[] = [];
	const code = await main([...args, '--user-data', userData, '--projects-dir', projects], {
		out: (s) => out.push(s), err: (s) => err.push(s),
		appRunning: typeof running === 'function' ? running : () => running,
		diagnoseDeps: noDiagnose, ...over,
	});
	return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Everything a relayout writes, as it is now — to prove a refusal or a dry run wrote nothing. */
function snapshot() {
	const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
	return {
		dirs: [wt1, wt2, nested(wt1), nested(wt2)].map((d) => fs.existsSync(d)),
		exclude: read(path.join(repo, '.git', 'info', 'exclude')),
		sessions: read(sessionsFile),
		config: read(configFile),
		projects: fs.readdirSync(projects).sort(),
		worktrees: git(repo, 'worktree', 'list', '--porcelain'),
	};
}

// ---------------------------------------------------------------------------------------------

describe('the app guard', () => {
	// Captured from this machine with the app open: tasklist cuts the image name at 25 characters.
	const truncated = 'Worktree Command Center.e    21232 Console                    1    150,748 K\r\nWorktree Command Center.e    37948 Console                    1    115,820 K\r\n';

	it('sees the app in tasklist output whose image name is truncated — where the full-name match never fired', () => {
		expect(/Worktree Command Center\.exe/i.test(truncated)).toBe(false); // the first version's bug
		expect(tasklistShows(truncated, APP_IMAGE)).toBe(true);
		expect(imageStem(APP_IMAGE)).toBe('Worktree Command Center');
	});

	it('reads "no tasks" as not running', () => {
		expect(tasklistShows('INFO: No tasks are running which match the specified criteria.\r\n', APP_IMAGE)).toBe(false);
	});

	it('treats a process list it cannot read as RUNNING', () => {
		expect(appIsRunning({ platform: 'win32', exec: () => { throw new Error('tasklist: access denied'); } })).toBe(true);
		expect(appIsRunning({ platform: 'darwin', exec: () => { throw new Error('ps missing'); } })).toBe(true);
	});

	it('asks tasklist with the image filter, and ps elsewhere', () => {
		const calls: string[][] = [];
		appIsRunning({ platform: 'win32', exec: (f, a) => { calls.push([f, ...a]); return truncated; } });
		appIsRunning({ platform: 'linux', exec: (f, a) => { calls.push([f, ...a]); return ''; } });
		expect(calls[0]).toEqual(['tasklist', '/FI', `IMAGENAME eq ${APP_IMAGE}`, '/NH']);
		expect(calls[1]![0]).toBe('ps');
		expect(psShows('/Applications/Worktree Command Center.app/Contents/MacOS/Worktree Command Center\n', APP_IMAGE)).toBe(true);
	});

	it.runIf(win)('fires against the REAL tasklist for a process that is running, and not for one that is not', () => {
		expect(appIsRunning({ image: 'node.exe' })).toBe(true); // this test runs in one
		expect(appIsRunning({ image: 'wcc-no-such-process-zz.exe' })).toBe(false);
	});
});

describe('arguments and targets', () => {
	it('parses a command, one repo and the flags; rejects the rest', () => {
		expect(parseArgs(['relayout', 'apartment-planner', '--apply'])).toEqual({ cmd: 'relayout', repo: 'apartment-planner', apply: true, probe: true });
		expect(parseArgs(['prune', '--no-probe'])).toEqual({ cmd: 'prune', apply: false, probe: false });
		expect(parseArgs(['move', 'x'])).toMatch(/unknown command/);
		expect(parseArgs(['prune', 'a', 'b'])).toMatch(/one repo at a time/);
		expect(parseArgs(['prune', '--force'])).toMatch(/unknown option/);
	});

	it('finds a target by name or path, refuses an unknown one and a folder target', () => {
		const repos = [{ name: 'A', path: 'C:\\x\\A' }, { name: 'F', path: 'C:\\x\\F', folder: true }];
		expect(selectTargets(repos, 'a', true)).toEqual([repos[0]]);
		expect(selectTargets(repos, undefined, true)).toEqual([repos[0]]);
		expect(() => selectTargets(repos, 'nope', true)).toThrow(/no repo target "nope"/);
		expect(() => selectTargets(repos, 'F', true)).toThrow(/folder target/);
	});

	it('exits 64 on a usage error and 2 on an unknown repo, with the reason on stderr', async () => {
		expect((await run(['frobnicate'])).code).toBe(EXIT.usage);
		const r = await run(['relayout', 'nope']);
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/REFUSING — no repo target "nope"/);
	});
});

describe('prune', () => {
	it('dry run: keeps the unmerged pilot worktree, saying why and what it would orphan; removes nothing', async () => {
		const before = snapshot();
		const r = await run(['prune', 'apartment-planner']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(/1 of 2 worktrees can be removed/);
		expect(r.out).toMatch(/✓ wt-main-1 \[wt\/main-1\] — merged into main — 0 conversations orphaned/);
		expect(r.out).toMatch(/✗ wt-main-2 \[wt\/main-2\] — not merged into main — 1 conversation orphaned/);
		expect(r.out).toMatch(/3 commits not in main .* \(3 unmatched\)/);
		expect(r.out).toMatch(/A saved terminal on tab apartment-planner \(wt-main-2\) resumes here/);
		expect(r.out).toMatch(/Dry run — nothing was removed/);
		expect(snapshot()).toEqual(before);
	});

	it('--apply while the app is running: refuses, exit 2, the reason on stderr, nothing removed', async () => {
		const before = snapshot();
		const r = await run(['prune', '--apply'], true);
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/REFUSING — Worktree Command Center is running/);
		expect(r.out).toBe('');
		expect(snapshot()).toEqual(before);
	});

	it('dry run while the app is running: every worktree kept as live-unknown, said on stderr', async () => {
		const r = await run(['prune'], true);
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(/^Nothing to prune: none of the 2 worktrees is merged, clean and unused. Kept: 2 not checked for running terminals/);
		expect(r.err).toMatch(/the app is running/);
	});

	it('--apply: removes the merged worktree, keeps its branch, leaves the unmerged one', async () => {
		const r = await run(['prune', '--apply']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(/Removed 1 of 1 worktree/);
		expect(fs.existsSync(wt1)).toBe(false);
		expect(fs.existsSync(wt2)).toBe(true);
		expect(git(repo, 'branch', '--list', 'wt/main-1')).toMatch(/wt\/main-1/);
	});

	it.runIf(win)('a merged worktree held by a process\'s cwd is kept, and the hold is named as cwd-holder', async () => {
		await holdOpen(wt1);
		const r = await run(['prune', '--apply'], false, { diagnoseDeps: realDiagnoseDeps() });
		expect(r.out).toMatch(/✗ wt-main-1 .*\n.*Busy \(EBUSY\) — a process's working directory is inside it/);
		expect(r.out).toMatch(/↳ failure mode cwd-holder: Held: node \(pid \d+\) has its working directory inside/);
		expect(r.out).toMatch(/Nothing to prune/);
		expect(fs.existsSync(wt1)).toBe(true);
	}, 120000);

	it('--apply refuses if the app starts between the plan and the removal', async () => {
		let n = 0;
		const r = await run(['prune', '--apply'], () => n++ > 0);
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/started after the dry run; nothing was removed/);
		expect(fs.existsSync(wt1)).toBe(true);
	});
});

describe('relayout', () => {
	it('dry run: prints every directory move, transcript rename, the exclude line and every session rewrite — and writes nothing', async () => {
		const before = snapshot();
		const r = await run(['relayout', 'apartment-planner']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toContain(`${wt1}\n    → ${nested(wt1)}`);
		expect(r.out).toContain(`${wt2}\n    → ${nested(wt2)}`);
		expect(r.out).toContain(`Exclude: ${path.join(repo, '.git', 'info', 'exclude')}\n  + /.claude-worktrees/`);
		expect(r.out).toContain(`${t2()}\n    → ${projectDirName(nested(wt2))}   (1 conversation)`);
		expect(r.out).toContain(`Saved terminal records rewritten (${sessionsFile}): 1`);
		expect(r.out).toContain(`[apartment-planner] wt-main-2 worktreePath ${wt2}\n    → ${nested(wt2)}`);
		expect(r.out).toMatch(/Dry run — nothing was moved/);
		expect(snapshot()).toEqual(before);
	});

	it('--apply while the app is running: refuses before anything, exit 2, nothing changed', async () => {
		const before = snapshot();
		const r = await run(['relayout', 'apartment-planner', '--apply'], true);
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/REFUSING — Worktree Command Center is running .* silently overwritten/);
		expect(snapshot()).toEqual(before);
	});

	it('--apply: updates all five — the directories, both link ends, the exclude, the transcript, the saved terminal', async () => {
		const r = await run(['relayout', 'apartment-planner', '--apply']);
		expect(r.err).toBe('');
		expect(r.code).toBe(EXIT.ok);
		// 1. the directories
		for (const w of [wt1, wt2]) { expect(fs.existsSync(w)).toBe(false); expect(fs.existsSync(nested(w))).toBe(true); }
		expect(fs.existsSync(path.dirname(oldRoot))).toBe(false); // the emptied shared root is gone
		// 2. both link ends: git lists them at the new paths, and git works from inside each
		const listed = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
		expect(listed).toEqual([repo, nested(wt1), nested(wt2)]);
		expect(git(nested(wt2), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/main-2');
		// 3. the exclude, so the repo's own status stays clean
		expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.claude-worktrees\/$/m);
		expect(git(repo, 'status', '--porcelain')).toBe('');
		// 4. the transcript
		expect(fs.existsSync(path.join(projects, t2()))).toBe(false);
		expect(fs.readdirSync(path.join(projects, projectDirName(nested(wt2))))).toEqual(['s1.jsonl']);
		// 5. the saved terminal, with a backup of the file beside it
		const s = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
		expect(s['apartment-planner'][0].worktreePath).toBe(nested(wt2));
		expect(s['apartment-planner'][0].repoPath).toBe(repo);
		expect(fs.readdirSync(userData).some((f) => f.startsWith('.terminal-sessions.json.bak-'))).toBe(true);
		expect(r.out).toMatch(/1 saved terminal record rewritten/);
		expect(r.out).toMatch(/Verifying/);

		const again = await run(['relayout', 'apartment-planner', '--apply']);
		expect(again.code).toBe(EXIT.ok);
		expect(again.out).toMatch(/nothing to relayout/);
	});

	it('stops before the saved-terminal write if the app starts mid-run; a re-run with it closed finishes', async () => {
		let running = false;
		const sessionsBefore = fs.readFileSync(sessionsFile, 'utf8');
		const r = await run(['relayout', 'apartment-planner', '--apply'], () => { const was = running; running = true; return was; });
		expect(r.code).toBe(EXIT.failed);
		expect(r.err).toMatch(/stopped at: Repointing config.json and saved terminals — the app is running now/);
		expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sessionsBefore);
		expect(fs.existsSync(nested(wt2))).toBe(true); // the moves themselves finished

		const resumed = await run(['relayout', 'apartment-planner', '--apply']);
		expect(resumed.code).toBe(EXIT.ok);
		expect(JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))['apartment-planner'][0].worktreePath).toBe(nested(wt2));
	});

	it('refuses when BOTH transcript folders exist rather than merging two histories — exit 2, nothing moved', async () => {
		fs.mkdirSync(path.join(projects, projectDirName(nested(wt2))));
		const before = snapshot();
		const r = await run(['relayout', 'apartment-planner', '--apply']);
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/REFUSING apartment-planner — 1 reason/);
		expect(r.err).toMatch(/Both .* exist in ~\/\.claude\/projects\. Renaming would merge two histories/);
		expect(snapshot()).toEqual(before);
	});

	it('warns when the destination is already keyed to an earlier worktree at that path', async () => {
		fs.mkdirSync(path.join(projects, projectDirName(nested(wt1))));
		const r = await run(['relayout', 'apartment-planner']);
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toMatch(new RegExp(`⚠ ${projectDirName(nested(wt1))} already exists in ~/.claude/projects, keyed to`));
	});

	it('names, and does not rename, a transcript folder whose mangled name cannot be reversed', async () => {
		fs.mkdirSync(path.join(projects, `${t2()}-sub`));
		const r = await run(['relayout', 'apartment-planner']);
		expect(r.out).toMatch(/1 transcript folder might belong to a subfolder .* cannot be reversed with certainty, so it is NOT renamed/);
		expect(r.out).not.toMatch(new RegExp(`${t2()}-sub\\n    →`));
	});

	it.runIf(win)('a process whose cwd is inside a worktree: refused as held, and named as failure mode cwd-holder', async () => {
		await holdOpen(wt2);
		const before = snapshot();
		const r = await run(['relayout', 'apartment-planner', '--apply'], false, { diagnoseDeps: realDiagnoseDeps() });
		expect(r.code).toBe(EXIT.refused);
		expect(r.err).toMatch(/is held open by/);
		expect(r.err).toMatch(/failure mode cwd-holder: Held: node \(pid \d+\) has its working directory inside/);
		expect(snapshot()).toEqual(before);
	}, 120000);
});

describe('the four failure modes, told apart', () => {
	const deps = (holders: string[] | null, syncRoots: string[] = []): DiagnoseDeps => ({
		findCwdHolders: async () => (holders ? { holders, unreadable: 0 } : null),
		contentsWritable: () => true,
		syncRoots,
	});

	it('classifies the errno family', () => {
		expect(errorKind('error: failed to move: Device or resource busy')).toBe('EBUSY');
		expect(errorKind('fatal: failed to move: Permission denied')).toBe('EPERM');
		expect(errorKind('fatal: failed to move: No such file or directory')).toBe('ENOENT');
		expect(errorKind('fatal: something else')).toBeNull();
	});

	it('Permission denied with a cwd holder → cwd-holder, naming it', async () => {
		const d = await diagnose('Permission denied', 'C:\\w', null, deps(['bash (pid 7)']));
		expect(d.mode).toBe('cwd-holder');
		expect(d.message).toMatch(/bash \(pid 7\) has its working directory inside C:\\w/);
	});

	it('Permission denied with no cwd holder → service-handle, contents still writable', async () => {
		const d = await diagnose('Permission denied', 'C:\\w', null, deps([]));
		expect(d.mode).toBe('service-handle');
		expect(d.message).toMatch(/still writable.*a reboot clears it/);
	});

	it("Node's EBUSY for the same cwd hold is still cwd-holder — the errno alone does not decide", async () => {
		expect((await diagnose('EBUSY', 'C:\\w', null, deps(['node (pid 3)']))).mode).toBe('cwd-holder');
		expect((await diagnose('EBUSY', 'C:\\w', null, deps([]))).mode).toBe('service-handle');
	});

	it('sync-engine: under a OneDrive root, or git\'s "Device or resource busy" — once no cwd holder is found', async () => {
		expect((await diagnose('EBUSY', 'C:\\Users\\u\\OneDrive\\dev\\w', null, deps([], ['C:\\Users\\u\\OneDrive']))).mode).toBe('sync-engine');
		expect((await diagnose('EBUSY', 'C:\\Users\\u\\OneDriveX\\w', null, deps([], ['C:\\Users\\u\\OneDrive']))).mode).toBe('service-handle');
		expect((await diagnose('error: failed: Device or resource busy', 'C:\\w', null, deps([]))).mode).toBe('sync-engine');
		expect((await diagnose('Device or resource busy', 'C:\\w', null, deps(['bash (pid 4)']))).mode).toBe('cwd-holder');
	});

	it('No such file → parent-missing, naming the parent', async () => {
		const d = await diagnose('No such file or directory', 'C:\\old\\w', 'C:\\new\\nest\\w', deps([]));
		expect(d.mode).toBe('parent-missing');
		expect(d.message).toMatch(/C:\\new\\nest is missing/);
	});

	it('Permission denied where the detector cannot run → no guess, both candidates named', async () => {
		const d = await diagnose('Permission denied', 'C:\\w', null, deps(null));
		expect(d.mode).toBeNull();
		expect(d.message).toMatch(/either a process's working directory is inside it, or a service/);
	});

	it('parses find-cwd-holder.ps1 output', () => {
		const out = 'scanned 312 processes; 41 could not be read (protected or 32/64-bit mismatch)\r\n  pid 9120  bash\r\n      cwd: C:\\w\\\r\n';
		expect(parseCwdHolderOutput(out)).toEqual({ holders: ['bash (pid 9120)'], unreadable: 41 });
		expect(parseCwdHolderOutput('scanned 3 processes; 0 could not be read\nNO process has its cwd inside the given path(s)\n')).toEqual({ holders: [], unreadable: 0 });
	});
});

describe('the bundle a plain node runs', () => {
	let bundle: string;
	beforeAll(async () => {
		bundle = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-worktrees-bundle-'))), 'wcc-worktrees.cjs');
		await esbuild.build({ entryPoints: [path.join(__dirname, '..', 'src', 'cli', 'wcc-worktrees.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
	});
	afterAll(() => { fs.rmSync(path.dirname(bundle), { recursive: true, force: true }); });
	const node = (args: string[], appProcess: string) => spawnSync(process.execPath, [bundle, ...args, '--user-data', userData, '--projects-dir', projects], { encoding: 'utf8', env: { ...process.env, WCC_APP_PROCESS: appProcess } });

	it('reaches the modules: a dry run prints the plan', () => {
		const r = node(['relayout', 'apartment-planner', '--no-probe'], 'wcc-no-such-process-zz.exe');
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`→ ${nested(wt2)}`);
	});

	it('the guard fires through the real process list: --apply refuses with exit 2 and moves nothing', () => {
		const before = snapshot();
		const r = node(['relayout', 'apartment-planner', '--apply'], win ? 'node.exe' : 'node');
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/REFUSING — Worktree Command Center is running/);
		expect(snapshot()).toEqual(before);
	});
});
