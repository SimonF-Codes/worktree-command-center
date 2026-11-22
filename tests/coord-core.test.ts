import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../pty-sidecar/coord-core.cjs');

describe('parseGitOp', () => {
  it('detects push and worktree add, including -C and cd prefixes', () => {
    expect(core.parseGitOp('git push')).toBe('push');
    expect(core.parseGitOp('git -C /a/b push origin main')).toBe('push');
    expect(core.parseGitOp('cd /y && git worktree add ../wt -b x main')).toBe('worktree-add');
    expect(core.parseGitOp('git commit -m hi')).toBeNull();
    expect(core.parseGitOp('ls -la')).toBeNull();
  });
});

describe('slug / baseName / gitResource', () => {
  it('slugs resource names', () => {
    expect(core.slug('paper-trader:db')).toBe('paper-trader-db');
    expect(core.slug('  ')).toBe('unnamed');
  });
  it('derives the git resource from the target repo', () => {
    expect(core.gitResource('push', 'git push', '/repo/foo')).toBe('push:foo');
    expect(core.gitResource('worktree-add', 'git -C "C:/x/MyRepo" worktree add z', '/repo/foo')).toBe('worktree:MyRepo');
  });
  it('names no resource for a placeholder target — text about a git command is not one', () => {
    expect(core.gitResource('worktree-add', 'git -C <repo> worktree add -b <branch> <path> <base>', '/repo/foo')).toBeNull();
    expect(core.gitResource('push', 'cd <repo> && git push', '/repo/foo')).toBeNull();
  });
  it('isPlausibleTarget: angle brackets and empty are never paths; ordinary paths are', () => {
    for (const t of ['<repo>', 'C:/dev/<name>', '', '   ', null, undefined]) expect(core.isPlausibleTarget(t)).toBe(false);
    for (const t of ['C:\\dev\\foo', '/repo/foo', '../sibling', 'MyRepo', '$d']) expect(core.isPlausibleTarget(t)).toBe(true);
  });
});

describe('lockStatus', () => {
  it('is free/held/stale around ts + ttlMs', () => {
    expect(core.lockStatus(null, 100)).toBe('free');
    expect(core.lockStatus({ ts: 0, ttlMs: 1000 }, 999)).toBe('held');
    expect(core.lockStatus({ ts: 0, ttlMs: 1000 }, 1001)).toBe('stale');
  });
});

describe('board line round-trip', () => {
  it('formats and parses a structured event', () => {
    const e = { ts: 123, terminal: 'termA', resource: 'paper-trader:db', status: 'START', detail: 'A/B replay' };
    const line = core.formatBoardLine(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(core.parseBoardLine(line)).toEqual(e);
  });
  it('keeps unstructured lines as raw and drops blanks', () => {
    expect(core.parseBoardLine('just some text')).toEqual({ raw: 'just some text' });
    expect(core.parseBoardLine('   ')).toBeNull();
  });
  it('mergeEvents sorts newest first', () => {
    const merged = core.mergeEvents([{ ts: 1 }, { ts: 3 }, { ts: 2 }]);
    expect(merged.map((e) => e.ts)).toEqual([3, 2, 1]);
  });
});

describe('taskLabel', () => {
  it('prefers description, falls back to a truncated prompt, then subagent_type', () => {
    expect(core.taskLabel({ description: 'audit auth middleware' })).toBe('audit auth middleware');
    expect(core.taskLabel({ prompt: 'do the thing' })).toBe('do the thing');
    expect(core.taskLabel({ subagent_type: 'Explore' })).toBe('Explore');
    expect(core.taskLabel({})).toBe('task');
  });
  it('truncates long prompts to 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const label = core.taskLabel({ prompt: long });
    expect(label.length).toBe(81); // 80 chars + ellipsis
    expect(label.endsWith('…')).toBe(true);
  });
});
