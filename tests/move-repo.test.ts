import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
	planMove, plannedDestinations, remapPath, isInside, worktreeRootFor, legacyWorktreeRootFor, parseWorktreePorcelain,
	parseGitmodulesPaths, gitdirOf, isAbsoluteGitdir, remapRepoLinks, remapSessionRecords,
	configPathRefs, describeMovePlan, describeRefusals, type MoveFacts, type WorktreeFact, type RefusalCode,
} from '../src/move-repo';
import { projectDirName } from '../src/terminals/resume-target';
import { worktreePathFor } from '../src/terminals/worktree-manager';

// The VerticalChess move of 2026-10-14, as fixtures: a repo nested one level too deep, its
// worktrees in the old shared .claude-worktrees root beside it, one loose worktree beside it, and
// transcripts keyed to some of those paths. The move lands them in the repo's own root. Built on path.resolve so the suite runs on any host.

const R = path.resolve('/dev');
const FROM = path.join(R, 'VerticalChess3DPrint', 'VerticalChess');
const TO = path.join(R, 'VerticalChess');
const OLD_ROOT = path.join(R, 'VerticalChess3DPrint', '.claude-worktrees', 'VerticalChess');
const NEW_ROOT = path.join(TO, '.claude-worktrees');

const wt = (p: string, branch: string, extra: Partial<WorktreeFact> = {}): WorktreeFact =>
	({ path: p, branch, isMain: false, prunable: false, locked: false, dirty: [], ...extra });

const MAIN = wt(FROM, 'main', { isMain: true });
const CANON_A = wt(path.join(OLD_ROOT, 'wt-main-1'), 'wt/main-1');
const CANON_B = wt(path.join(OLD_ROOT, 'wt-main-2'), 'wt/main-2');
const LOOSE = wt(path.join(R, 'VerticalChess3DPrint', 'wt-v3'), 'v3');

function facts(over: Partial<MoveFacts> = {}): MoveFacts {
	return {
		from: FROM, to: TO, repoName: 'VerticalChess',
		fromExists: true, toExists: false, kind: 'repo', folderTarget: false,
		worktrees: [MAIN, CANON_A, CANON_B, LOOSE],
		remotes: ['origin'], absoluteSubmodules: [], livePaths: [], heldOpen: [],
		transcriptDirs: [projectDirName(FROM), projectDirName(CANON_A.path), 'C--unrelated-project'],
		existing: [], targets: [{ name: 'VerticalChess', path: FROM }, { name: 'Other', path: path.join(R, 'Other') }],
		configRefs: [], caseInsensitive: false,
		...over,
	};
}

const codes = (f: MoveFacts): RefusalCode[] => planMove(f).refusals.map((r) => r.code);

describe('planMove — the whole plan', () => {
	const p = planMove(facts());

	it('refuses nothing for a clean, quiet repo', () => {
		expect(p.refusals).toEqual([]);
	});

	it('relocates worktrees in the old canonical root into the root the new location implies', () => {
		expect(p.oldWorktreeRoot).toBe(OLD_ROOT);
		expect(p.newWorktreeRoot).toBe(NEW_ROOT);
		expect(p.worktreeMoves).toEqual([
			{ from: CANON_A.path, to: path.join(NEW_ROOT, 'wt-main-1'), branch: 'wt/main-1', done: false },
			{ from: CANON_B.path, to: path.join(NEW_ROOT, 'wt-main-2'), branch: 'wt/main-2', done: false },
		]);
	});

	it('leaves a worktree outside the canonical root where it is, and repairs it in place', () => {
		expect(p.staying).toEqual([{ path: LOOSE.path, branch: 'v3' }]);
		expect(p.repair).toContain(LOOSE.path);
		expect(p.warnings.join('\n')).toContain(LOOSE.path);
	});

	it('repairs every worktree where it is at the moment the repair runs — before relocation', () => {
		expect(p.repair.sort()).toEqual([CANON_A.path, CANON_B.path, LOOSE.path].sort());
	});

	it('maps the repo and each relocation, and a path inside a moved directory follows it', () => {
		expect(p.pathMap).toEqual([
			{ from: FROM, to: TO },
			{ from: CANON_A.path, to: path.join(NEW_ROOT, 'wt-main-1') },
			{ from: CANON_B.path, to: path.join(NEW_ROOT, 'wt-main-2') },
		]);
		expect(remapPath(path.join(FROM, 'src', 'x.ts'), p.pathMap, false)).toBe(path.join(TO, 'src', 'x.ts'));
	});

	it('renames exactly the transcript folders keyed to moving paths, and no others', () => {
		expect(p.transcripts).toEqual([
			{ from: projectDirName(FROM), to: projectDirName(TO), done: false },
			{ from: projectDirName(CANON_A.path), to: projectDirName(path.join(NEW_ROOT, 'wt-main-1')), done: false },
		]);
	});

	it('expects every worktree to resolve afterwards at its new path', () => {
		expect(p.expectedWorktrees.sort()).toEqual([path.join(NEW_ROOT, 'wt-main-1'), path.join(NEW_ROOT, 'wt-main-2'), LOOSE.path].sort());
	});

	it('names what it will do in the confirm text', () => {
		const text = describeMovePlan(p);
		expect(text).toContain(TO);
		expect(text).toContain('wt-main-1');
		expect(text).toContain(projectDirName(TO));
		expect(text).toContain('git worktree repair');
	});
});

describe('planMove — a rename in the same parent', () => {
	it('still relocates worktrees left in the old shared root into the renamed repo', () => {
		const to = path.join(R, 'VerticalChess3DPrint', 'Chess');
		const p = planMove(facts({ to }));
		expect(p.refusals).toEqual([]);
		expect(p.newWorktreeRoot).toBe(path.join(to, '.claude-worktrees'));
		expect(p.worktreeMoves.map((m) => m.to)).toEqual([path.join(to, '.claude-worktrees', 'wt-main-1'), path.join(to, '.claude-worktrees', 'wt-main-2')]);
		expect(p.staying.map((s) => s.path)).toEqual([LOOSE.path]);
		expect(plannedDestinations(facts({ to }))).toEqual(p.worktreeMoves.map((m) => m.to));
	});
});

describe('planMove — worktrees nested inside the repo', () => {
	const nested = wt(path.join(FROM, '.worktrees', 'feat'), 'feat');

	it('carries them with the directory and repairs them at their new path', () => {
		const p = planMove(facts({ worktrees: [MAIN, nested], transcriptDirs: [projectDirName(nested.path)] }));
		expect(p.carried).toEqual([{ from: nested.path, to: path.join(TO, '.worktrees', 'feat') }]);
		expect(p.repair).toEqual([path.join(TO, '.worktrees', 'feat')]);
		expect(p.worktreeMoves).toEqual([]);
		expect(p.transcripts).toEqual([{ from: projectDirName(nested.path), to: projectDirName(path.join(TO, '.worktrees', 'feat')), done: false }]);
	});
});

describe('planMove — resuming a move that stopped halfway', () => {
	// The directory moved, and one worktree was relocated, before the run stopped. Git (after the
	// repair) now reports CANON_A at its new home and CANON_B still in the old root. CANON_A now
	// sits inside the repo, so only the journal says it was relocated rather than always there.
	const movedA = wt(path.join(NEW_ROOT, 'wt-main-1'), 'wt/main-1');
	const resumed = facts({
		priorRelocations: [{ from: CANON_A.path, to: movedA.path }, { from: CANON_B.path, to: path.join(NEW_ROOT, 'wt-main-2') }],
		fromExists: false, toExists: true,
		worktrees: [wt(TO, 'main', { isMain: true }), movedA, CANON_B, LOOSE],
		transcriptDirs: [projectDirName(TO), projectDirName(CANON_A.path)],
		targets: [{ name: 'VerticalChess', path: FROM }],
	});
	const p = planMove(resumed);

	it('replans into exactly the steps left', () => {
		expect(p.refusals).toEqual([]);
		expect(p.resuming).toBe(true);
		expect(p.worktreeMoves).toEqual([
			{ from: CANON_A.path, to: movedA.path, branch: 'wt/main-1', done: true },
			{ from: CANON_B.path, to: path.join(NEW_ROOT, 'wt-main-2'), branch: 'wt/main-2', done: false },
		]);
	});

	it('marks the repo transcript done and still renames the relocated worktree\'s', () => {
		expect(p.transcripts).toEqual([
			{ from: projectDirName(FROM), to: projectDirName(TO), done: true },
			{ from: projectDirName(CANON_A.path), to: projectDirName(movedA.path), done: false },
		]);
	});

	it('keeps the full path map, so config and sessions still repoint everything', () => {
		expect(p.pathMap.map((m) => m.from)).toEqual([FROM, CANON_A.path, CANON_B.path]);
	});

	it('says it is resuming', () => {
		expect(p.warnings.join('\n')).toMatch(/Resuming/);
		expect(describeMovePlan(p)).toContain('resuming');
	});

	it('carries a nested worktree git still reports at the old path (repair not yet run)', () => {
		const nestedOld = wt(path.join(FROM, 'inner'), 'inner', { prunable: true });
		const q = planMove({ ...resumed, worktrees: [wt(TO, 'main', { isMain: true }), nestedOld] });
		expect(q.carried).toEqual([{ from: nestedOld.path, to: path.join(TO, 'inner') }]);
		expect(q.warnings.join('\n')).not.toContain('prunable');
	});
});

// Every refusal must be proven to FIRE. The stopgap script's guard against the running app
// compiled, ran, and never once matched (tasklist truncates the image name) — a guard that
// silently does not guard is worse than none.
describe('planMove — refusals', () => {
	it('refuses a directory held open by a process, naming the holder when known', () => {
		const p = planMove(facts({ heldOpen: [{ path: LOOSE.path, holders: ['node.exe (pid 32552)'] }, { path: FROM, holders: [] }] }));
		expect(p.refusals.map((r) => r.code)).toEqual(['held-open', 'held-open']);
		expect(p.refusals[0]!.message).toContain('node.exe (pid 32552)');
		expect(p.refusals[1]!.message).toContain('Associated Handles');
	});

	it('refuses a live terminal inside the repo, a relocating worktree, or a staying one', () => {
		expect(codes(facts({ livePaths: [path.join(FROM, 'sub')] }))).toEqual(['live-terminal']);
		expect(codes(facts({ livePaths: [CANON_B.path] }))).toEqual(['live-terminal']);
		expect(codes(facts({ livePaths: [LOOSE.path] }))).toEqual(['live-terminal']);
	});

	it('does not refuse a live terminal in an unrelated repo with a shared prefix', () => {
		expect(codes(facts({ livePaths: [FROM + '2', path.join(R, 'Other')] }))).toEqual([]);
	});

	it('refuses anything dirty — the repo itself or any worktree — and names the files', () => {
		const p = planMove(facts({ worktrees: [{ ...MAIN, dirty: [' M a.txt'] }, { ...CANON_A, dirty: ['?? new.ts', ' M b.ts'] }, CANON_B, LOOSE] }));
		expect(p.refusals.map((r) => r.code)).toEqual(['dirty', 'dirty']);
		expect(p.refusals[0]!.message).toContain('a.txt');
		expect(p.refusals[1]!.message).toMatch(/2 uncommitted changes: new\.ts, b\.ts/);
		expect(p.refusals[1]!.message).toContain('wip:');
	});

	it('warns — before, not after — that a repo with no remote exists on this disk only', () => {
		const p = planMove(facts({ remotes: [] }));
		expect(p.refusals).toEqual([]);
		expect(p.warnings.join('\n')).toMatch(/no remote/);
		expect(describeMovePlan(p)).toMatch(/no remote/);
	});

	it('refuses an absolute submodule gitdir', () => {
		const p = planMove(facts({ absoluteSubmodules: [{ path: path.join(FROM, 'lib'), gitdir: 'C:/dev/x/.git/modules/lib' }] }));
		expect(p.refusals.map((r) => r.code)).toEqual(['absolute-submodule']);
		expect(p.refusals[0]!.message).toContain('absorbgitdirs');
	});

	it('refuses a destination that exists, a missing repo, and moving onto itself or into itself', () => {
		expect(codes(facts({ toExists: true }))).toEqual(['destination-exists']);
		expect(codes(facts({ fromExists: false }))).toEqual(['missing']);
		expect(codes(facts({ to: FROM, worktrees: [MAIN, LOOSE] }))).toEqual(['nothing-to-relayout']);
		expect(codes(facts({ to: path.join(FROM, 'inner') }))).toEqual(['inside-itself']);
	});

	it.runIf(process.platform === 'win32')('refuses a move across drives', () => {
		expect(codes(facts({ to: 'Z:\\VerticalChess' }))).toEqual(['cross-volume']);
	});

	it('refuses a worktree, a non-repo, and a folder target', () => {
		expect(codes(facts({ kind: 'worktree' }))).toEqual(['not-primary']);
		expect(codes(facts({ kind: 'folder' }))).toEqual(['not-a-repo']);
		expect(codes(facts({ folderTarget: true, kind: 'folder' }))).toEqual(['folder-target']);
	});

	it('refuses a destination another target already owns', () => {
		expect(codes(facts({ targets: [{ name: 'VerticalChess', path: FROM }, { name: 'Clash', path: TO }] }))).toEqual(['target-taken']);
	});

	it('refuses a locked worktree it would have to relocate, and a relocation onto something', () => {
		expect(codes(facts({ worktrees: [MAIN, { ...CANON_A, locked: true }] }))).toEqual(['locked-worktree']);
		expect(codes(facts({ existing: [path.join(NEW_ROOT, 'wt-main-2')] }))).toEqual(['worktree-destination-exists']);
	});

	it('refuses to merge two transcript histories', () => {
		const p = planMove(facts({ transcriptDirs: [projectDirName(FROM), projectDirName(TO)] }));
		expect(p.refusals.map((r) => r.code)).toEqual(['transcript-conflict']);
		expect(describeRefusals(p)).toContain(projectDirName(TO));
	});

	it('collects every refusal at once, so one re-check can clear them all', () => {
		expect(codes(facts({ livePaths: [CANON_A.path], heldOpen: [{ path: FROM, holders: [] }], remotes: [] }))).toEqual(['live-terminal', 'held-open']);
	});
});

describe('planMove — transcripts', () => {
	it('does not rename a sibling whose mangled name merely starts the same, and says so', () => {
		const sibling = projectDirName(CANON_A.path) + '-fix'; // wt-main-1-fix, not wt-main-1
		const p = planMove(facts({ transcriptDirs: [projectDirName(CANON_A.path), sibling] }));
		expect(p.transcripts.map((t) => t.from)).toEqual([projectDirName(CANON_A.path)]);
		expect(p.warnings.join('\n')).toContain(sibling);
	});

	it('wt-main-1 never claims wt-main-10', () => {
		const ten = wt(path.join(OLD_ROOT, 'wt-main-10'), 'wt/main-10');
		const p = planMove(facts({ worktrees: [MAIN, CANON_A, ten], transcriptDirs: [projectDirName(ten.path)] }));
		expect(p.transcripts).toEqual([{ from: projectDirName(ten.path), to: projectDirName(path.join(NEW_ROOT, 'wt-main-10')), done: false }]);
	});

	it('matches a transcript spelled in another case when paths are case-insensitive', () => {
		const lower = projectDirName(FROM).toLowerCase();
		const p = planMove(facts({ caseInsensitive: true, transcriptDirs: [lower] }));
		expect(p.transcripts).toEqual([{ from: lower, to: projectDirName(TO), done: false }]);
	});

	it('warns about a missing (prunable) worktree instead of trying to move it', () => {
		const p = planMove(facts({ worktrees: [MAIN, { ...CANON_A, prunable: true }] }));
		expect(p.worktreeMoves).toEqual([]);
		expect(p.expectedWorktrees).toEqual([]);
		expect(p.warnings.join('\n')).toMatch(/already missing/);
	});
});

// The migration to the nested layout: from === to. The repo stays; only worktrees in the old
// shared root move, into <repo>/.claude-worktrees.
describe('planMove — relayout (from === to)', () => {
	const REPO = FROM;
	const IN = path.join(REPO, '.claude-worktrees');
	const NATIVE = wt(path.join(IN, 'wt-main-5'), 'wt/main-5'); // created by a build that nests
	const relayout = (over: Partial<MoveFacts> = {}): MoveFacts => facts({ to: REPO, worktrees: [MAIN, CANON_A, CANON_B, LOOSE, NATIVE], ...over });
	const p = planMove(relayout());

	it('moves each worktree in the old shared root into the repo, and nothing else', () => {
		expect(p.refusals).toEqual([]);
		expect(p.relayout).toBe(true);
		expect(p.resuming).toBe(false);
		expect(p.newWorktreeRoot).toBe(IN);
		expect(p.worktreeMoves).toEqual([
			{ from: CANON_A.path, to: path.join(IN, 'wt-main-1'), branch: 'wt/main-1', done: false },
			{ from: CANON_B.path, to: path.join(IN, 'wt-main-2'), branch: 'wt/main-2', done: false },
		]);
		expect(p.carried).toEqual([]);
		expect(p.staying.map((s) => s.path)).toEqual([LOOSE.path]);
	});

	it('repairs nothing — git worktree move rewrites both ends itself — and maps only the relocations', () => {
		expect(p.repair).toEqual([]);
		expect(p.pathMap).toEqual([
			{ from: CANON_A.path, to: path.join(IN, 'wt-main-1') },
			{ from: CANON_B.path, to: path.join(IN, 'wt-main-2') },
		]);
	});

	it('renames only the relocated worktrees\' transcripts, never the repo\'s own', () => {
		expect(p.transcripts).toEqual([{ from: projectDirName(CANON_A.path), to: projectDirName(path.join(IN, 'wt-main-1')), done: false }]);
	});

	it('still expects every worktree — moved, staying and already nested — to resolve', () => {
		expect(p.expectedWorktrees.sort()).toEqual([path.join(IN, 'wt-main-1'), path.join(IN, 'wt-main-2'), LOOSE.path, NATIVE.path].sort());
	});

	it('only refuses for what it relocates: a dirty or live repo checkout or staying worktree is fine', () => {
		const dirtyElsewhere = relayout({
			worktrees: [{ ...MAIN, dirty: [' M a.txt'] }, CANON_A, { ...LOOSE, dirty: ['?? x'] }, { ...NATIVE, dirty: ['?? y'] }],
			livePaths: [REPO, LOOSE.path, NATIVE.path],
		});
		expect(codes(dirtyElsewhere)).toEqual([]);
		expect(codes(relayout({ worktrees: [MAIN, { ...CANON_A, dirty: [' M b.ts'] }] }))).toEqual(['dirty']);
		expect(codes(relayout({ livePaths: [CANON_B.path] }))).toEqual(['live-terminal']);
		expect(codes(relayout({ livePaths: [path.join(IN, 'wt-main-1', 'src')] }))).toEqual(['live-terminal']);
	});

	it('refuses a worktree with submodules checked out — git will not move one', () => {
		const q = planMove(relayout({ submoduleWorktrees: [CANON_B.path] }));
		expect(q.refusals.map((r) => r.code)).toEqual(['submodule-worktree']);
		expect(q.refusals[0]!.path).toBe(CANON_B.path);
		expect(codes(relayout({ submoduleWorktrees: [NATIVE.path] }))).toEqual([]); // not moving, not refused
	});

	it('ignores an absolute submodule gitdir it does not move', () => {
		expect(codes(relayout({ absoluteSubmodules: [{ path: path.join(REPO, 'lib'), gitdir: 'C:/x/.git/modules/lib' }] }))).toEqual([]);
		expect(codes(relayout({ absoluteSubmodules: [{ path: path.join(CANON_A.path, 'lib'), gitdir: 'C:/x/.git/modules/lib' }] }))).toEqual(['absolute-submodule']);
	});

	it('says there is nothing to do once every worktree is nested', () => {
		const q = planMove(relayout({ worktrees: [MAIN, NATIVE] }));
		expect(q.refusals.map((r) => r.code)).toEqual(['nothing-to-relayout']);
		expect(q.refusals[0]!.message).toMatch(/already lives inside the repo/);
	});

	it('resumes from its journal: a finished relocation is done, its transcript still renamed', () => {
		const movedA = wt(path.join(IN, 'wt-main-1'), 'wt/main-1');
		const q = planMove(relayout({
			worktrees: [MAIN, movedA, CANON_B],
			priorRelocations: [{ from: CANON_A.path, to: movedA.path }, { from: CANON_B.path, to: path.join(IN, 'wt-main-2') }],
		}));
		expect(q.refusals).toEqual([]);
		expect(q.worktreeMoves).toEqual([
			{ from: CANON_A.path, to: movedA.path, branch: 'wt/main-1', done: true },
			{ from: CANON_B.path, to: path.join(IN, 'wt-main-2'), branch: 'wt/main-2', done: false },
		]);
		expect(q.transcripts).toEqual([{ from: projectDirName(CANON_A.path), to: projectDirName(movedA.path), done: false }]);
		expect(describeMovePlan(q)).toMatch(/wt-main-1 \[wt\/main-1\]\s+✓ already/);
	});

	it('marks a transcript done once a resumed run already renamed it', () => {
		const movedA = wt(path.join(IN, 'wt-main-1'), 'wt/main-1');
		const q = planMove(relayout({
			worktrees: [MAIN, movedA, CANON_B],
			priorRelocations: [{ from: CANON_A.path, to: movedA.path }],
			transcriptDirs: [projectDirName(movedA.path)],
		}));
		expect(q.transcripts).toEqual([{ from: projectDirName(CANON_A.path), to: projectDirName(movedA.path), done: true }]);
	});

	it('without a journal, a worktree already inside the repo is just nested — never claimed as a relocation', () => {
		const movedA = wt(path.join(IN, 'wt-main-1'), 'wt/main-1');
		const q = planMove(relayout({ worktrees: [MAIN, movedA, CANON_B] }));
		expect(q.worktreeMoves.map((m) => m.from)).toEqual([CANON_B.path]);
		expect(q.transcripts).toEqual([]); // CANON_A's transcript is not handed to whatever sits at movedA
	});

	it('warns when a history is already keyed to a destination path', () => {
		const stale = projectDirName(path.join(IN, 'wt-main-2'));
		const q = planMove(relayout({ transcriptDirs: [stale] }));
		expect(q.refusals).toEqual([]);
		expect(q.warnings.join('\n')).toContain(stale);
	});

	it('says in the confirm text that the repo stays and the exclude rule is written first', () => {
		const text = describeMovePlan(p);
		expect(text).toContain('stays where it is');
		expect(text).toContain('.git/info/exclude');
		expect(text).not.toContain('git worktree repair');
		expect(text).toContain('the target itself does not change');
	});

	it('refuses a relayout of a repo that is not there', () => {
		expect(codes(relayout({ fromExists: false, toExists: false }))).toEqual(['missing']);
	});
});

describe('path helpers', () => {
	it('isInside is separator-bounded', () => {
		expect(isInside(path.join(R, 'Repo', 'x'), path.join(R, 'Repo'), false)).toBe(true);
		expect(isInside(path.join(R, 'Repo2'), path.join(R, 'Repo'), false)).toBe(false);
	});

	it('remapPath prefers the longest matching source', () => {
		const map = [{ from: path.join(R, 'a'), to: path.join(R, 'b') }, { from: path.join(R, 'a', 'wt'), to: path.join(R, 'w') }];
		expect(remapPath(path.join(R, 'a', 'wt', 'f'), map, false)).toBe(path.join(R, 'w', 'f'));
		expect(remapPath(path.join(R, 'a', 'z'), map, false)).toBe(path.join(R, 'b', 'z'));
		expect(remapPath(path.join(R, 'q'), map, false)).toBe(path.join(R, 'q'));
	});

	it('worktreeRootFor matches worktreePathFor, and the legacy root is the shared one beside the repo', () => {
		expect(worktreeRootFor(TO)).toBe(NEW_ROOT);
		expect(path.dirname(worktreePathFor(TO, 'wt/main-1'))).toBe(NEW_ROOT);
		expect(legacyWorktreeRootFor(FROM, 'VerticalChess')).toBe(OLD_ROOT);
	});
});

describe('parsing', () => {
	it('parses worktree porcelain with prunable, locked, detached and bare entries', () => {
		const s = [
			'worktree C:/dev/Repo', 'HEAD abc', 'branch refs/heads/main', '',
			'worktree C:/dev/.claude-worktrees/Repo/wt-1', 'HEAD def', 'branch refs/heads/wt/main-1', 'locked', '',
			'worktree C:/gone', 'HEAD 123', 'detached', 'prunable gitdir file points to non-existent location', '',
		].join('\r\n');
		const out = parseWorktreePorcelain(s);
		expect(out).toEqual([
			{ path: path.resolve('C:/dev/Repo'), branch: 'main', isMain: true, prunable: false, locked: false },
			{ path: path.resolve('C:/dev/.claude-worktrees/Repo/wt-1'), branch: 'wt/main-1', isMain: false, prunable: false, locked: true },
			{ path: path.resolve('C:/gone'), branch: '', isMain: false, prunable: true, locked: false },
		]);
		expect(parseWorktreePorcelain('worktree /x/bare.git\nbare\n')).toEqual([]);
	});

	it('reads submodule paths and gitdirs, and tells relative from absolute', () => {
		expect(parseGitmodulesPaths('[submodule "a"]\n\tpath = Buissness-Card\n\turl = x\n[submodule "b"]\n  path=site\n')).toEqual(['Buissness-Card', 'site']);
		expect(gitdirOf('gitdir: ../.git/modules/a\n')).toBe('../.git/modules/a');
		expect(gitdirOf('not a gitdir')).toBeNull();
		expect(isAbsoluteGitdir('../.git/modules/a')).toBe(false);
		expect(isAbsoluteGitdir('C:/dev/x/.git/modules/a')).toBe(true);
		expect(isAbsoluteGitdir('/home/x/.git/modules/a')).toBe(true);
	});
});

describe('applying the path map', () => {
	const map = [{ from: FROM, to: TO }, { from: CANON_A.path, to: path.join(NEW_ROOT, 'wt-main-1') }];

	it('repoints linked tabs and tombstones, leaving others and unlinked ones identical', () => {
		const other = { id: 'b', name: 'B', repo: path.join(R, 'Other') };
		const unlinked = { id: 'c', name: 'C' };
		const out = remapRepoLinks([{ id: 'a', name: 'A', repo: FROM }, other, unlinked], map, false);
		expect(out[0]).toEqual({ id: 'a', name: 'A', repo: TO });
		expect(out[1]).toBe(other);
		expect(out[2]).toBe(unlinked);
	});

	it('rewrites saved tiles in every bucket, closed tabs included, and counts them', () => {
		const rec = (worktreePath: string, repoPath: string) => ({ worktreePath, repoPath, branch: 'b', repoName: 'VerticalChess', baseBranch: 'main' });
		const journal = rec('', '');
		const { all, changed } = remapSessionRecords({
			ws: [rec(CANON_A.path, FROM), rec(LOOSE.path, FROM), journal],
			'closed:old:1': [rec(CANON_A.path, FROM)],
			elsewhere: [rec(path.join(R, 'Other', 'x'), path.join(R, 'Other'))],
		}, map, false);
		expect(changed).toBe(3);
		expect(all.ws![0]).toMatchObject({ worktreePath: path.join(NEW_ROOT, 'wt-main-1'), repoPath: TO });
		expect(all.ws![1]).toMatchObject({ worktreePath: LOOSE.path, repoPath: TO });
		expect(all.ws![2]).toBe(journal);
		expect(all['closed:old:1']![0]!.worktreePath).toBe(path.join(NEW_ROOT, 'wt-main-1'));
		expect(all.elsewhere![0]!.worktreePath).toBe(path.join(R, 'Other', 'x'));
	});

	it('names other config values that point inside the repo, skipping the ones the move rewrites', () => {
		const cfg = { repos: [{ path: FROM }], workspaces: [{ repo: FROM }], god: { sourceRepo: FROM }, roleLibrary: { path: path.join(R, 'vault') }, list: [path.join(FROM, 'x')], n: 3 };
		expect(configPathRefs(cfg, FROM, false)).toEqual(['god.sourceRepo', 'list[0]']);
		expect(planMove(facts({ configRefs: ['god.sourceRepo'] })).warnings.join('\n')).toContain('god.sourceRepo');
	});
});
