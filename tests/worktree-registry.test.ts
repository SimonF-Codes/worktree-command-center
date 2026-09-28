import { describe, it, expect } from 'vitest';
import { nextWorktreeBranch } from '../src/terminals/worktree-registry';
import { parseWorktreeList, parseStatusPorcelain, parseAheadBehind } from '../src/terminals/worktree-registry';
import { computeState, isParkCommitSubject, parkCommitSubject, relAge, summarizeFiles, type WorktreeEntry } from '../src/terminals/worktree-registry';
import { formatRegistryMarkdown, parseBranchTips } from '../src/terminals/worktree-registry';

describe('parseBranchTips', () => {
  it('maps each local branch to its tip date (ms) and subject, from one for-each-ref call', () => {
    const out = [
      "refs/heads/main\t1790563466\tMerge remote-tracking branch 'origin/main'",
      'refs/heads/wt/main-7\t1789623019\twip: auto-parked 2026-09-17T05:30:19.706Z (Worktree Command Center)',
      'refs/heads/odd\t1789000000\tsubject\twith a tab',
      'garbage line',
      'refs/heads/bad\tnotanumber\tx',
      '',
    ].join('\r\n');
    const tips = parseBranchTips(out);
    expect([...tips.keys()]).toEqual(['main', 'wt/main-7', 'odd']);
    expect(tips.get('main')!.committedAt).toBe(1790563466000);
    expect(isParkCommitSubject(tips.get('wt/main-7')!.subject)).toBe(true);
    expect(tips.get('odd')!.subject).toBe('subject\twith a tab');
  });
});

describe('nextWorktreeBranch', () => {
  it('returns the next free wt/<base>-N from real branches (never an existing name)', () => {
    expect(nextWorktreeBranch([], 'main')).toBe('wt/main-1');
    expect(nextWorktreeBranch(['wt/main-1', 'wt/main-3'], 'main')).toBe('wt/main-4'); // max+1, not gap-fill
    expect(nextWorktreeBranch(['main', 'wt/other-9'], 'main')).toBe('wt/main-1');     // ignores other bases
    expect(nextWorktreeBranch(['wt/feature-x-2'], 'feature/x')).toBe('wt/feature-x-3'); // slugifies base
    expect(nextWorktreeBranch(['wt/main-1-foo'], 'main')).toBe('wt/main-1');           // suffix must be pure digits
  });
});

describe('parseWorktreeList', () => {
  it('parses `git worktree list --porcelain` into {path, branch}', () => {
    const out = [
      'worktree C:/r/repo', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree C:/r/.claude-worktrees/repo/wt-main-1', 'HEAD bbb', 'branch refs/heads/wt/main-1', '',
      'worktree C:/r/det', 'HEAD ccc', 'detached', '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: 'C:/r/repo', branch: 'main' },
      { path: 'C:/r/.claude-worktrees/repo/wt-main-1', branch: 'wt/main-1' },
      { path: 'C:/r/det', branch: '(detached)' },
    ]);
  });
});

describe('parseStatusPorcelain', () => {
  it('returns changed file paths, ignoring blanks', () => {
    expect(parseStatusPorcelain(' M a.ts\n?? b.ts\nA  c.ts\n')).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(parseStatusPorcelain('')).toEqual([]);
  });
});

describe('parseAheadBehind', () => {
  it('parses `rev-list --left-right --count base...HEAD` as behind<TAB>ahead', () => {
    expect(parseAheadBehind('0\t2')).toEqual({ ahead: 2, behind: 0 });
    expect(parseAheadBehind('3\t1')).toEqual({ ahead: 1, behind: 3 });
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 });
  });
});

const base = (o: Partial<WorktreeEntry>): WorktreeEntry => ({
  repo: 'r', branch: 'wt/main-1', path: '/p', terminal: 'T1',
  dirtyFiles: [], ahead: 0, behind: 0, parked: false, lastActivity: 0, lastCommitAt: null, ...o,
});

describe('computeState', () => {
  it('orders parked > dirty > ahead > clean', () => {
    expect(computeState(base({ parked: true, dirtyFiles: ['a'] }))).toBe('parked');
    expect(computeState(base({ dirtyFiles: ['a'] }))).toBe('dirty');
    expect(computeState(base({ ahead: 2 }))).toBe('ahead');
    expect(computeState(base({}))).toBe('clean');
  });
});

describe('park-commit subject', () => {
  it('round-trips: a built subject is recognized, a real one is not', () => {
    expect(isParkCommitSubject(parkCommitSubject('2026-05-31T14:02:00Z'))).toBe(true);
    expect(isParkCommitSubject('fix: real commit')).toBe(false);
  });
});

describe('relAge / summarizeFiles', () => {
  it('renders compact relative age', () => {
    expect(relAge(5_000)).toBe('5s');
    expect(relAge(120_000)).toBe('2m');
    expect(relAge(7_200_000)).toBe('2.0h');
  });
  it('crosses the s→m and m→h thresholds at the 90-unit midpoint (1m and 1.0h are never emitted)', () => {
    expect(relAge(89_400)).toBe('89s');     // just under the s→m flip
    expect(relAge(89_500)).toBe('2m');      // rounds to 90s → minutes (skips "1m")
    expect(relAge(5_340_000)).toBe('89m');  // just under the m→h flip
    expect(relAge(5_370_000)).toBe('1.5h'); // rounds to 90m → hours (skips "1.0h")
  });
  it('summarizes a file list with overflow and singular grammar', () => {
    expect(summarizeFiles(['only.ts'])).toBe('1 file (only.ts)');
    expect(summarizeFiles(['a.ts', 'b.ts'])).toBe('2 files (a.ts, b.ts)');
    expect(summarizeFiles(['a', 'b', 'c', 'd'])).toBe('4 files (a, b, +2)');
    expect(summarizeFiles([])).toBe('');
  });
});

describe('formatRegistryMarkdown', () => {
  it('renders empty state', () => {
    expect(formatRegistryMarkdown([], 1000)).toContain('No active worktrees');
  });
  it('groups by repo and flags dirty/parked/ahead with age', () => {
    const now = 100_000;
    const md = formatRegistryMarkdown([
      base({ repo: 'pt', branch: 'wt/main-3', dirtyFiles: ['a.py', 'b.py', 'c.py'], ahead: 2, lastActivity: now - 120_000 }),
      base({ repo: 'pt', branch: 'wt/main-1', terminal: 'T1', lastActivity: now - 5_000 }),
      base({ repo: 'if', branch: 'wt/main-2', terminal: null, parked: true, lastActivity: now - 480_000 }),
    ], now);
    expect(md).toContain('## pt');
    expect(md).toContain('## if');
    expect(md).toContain('[DIRTY]');
    expect(md).toContain('↑2');
    expect(md).toContain('[PARKED]');
    expect(md).toContain('(terminal closed)');
    expect(md).toContain('2m');
  });
});
