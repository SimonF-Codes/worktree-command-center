import { describe, it, expect } from 'vitest';
import {
  parseOutboxMessage, resolveTellTarget, slug,
  formatFloorSnapshot, formatFloorIndex, godSystemPrompt, EFFORT_LEVELS, remapWatchers, parseGodSelfImprove,
  planClose, closeResultText, type CloseCandidate,
} from '../src/terminals/god';

describe('parseOutboxMessage', () => {
  it('parses a tell (and treats an untagged target+message as tell)', () => {
    expect(parseOutboxMessage('{"kind":"tell","target":"Improver 1","message":"rebase"}'))
      .toEqual({ kind: 'tell', target: 'Improver 1', message: 'rebase' });
    expect(parseOutboxMessage('{"ts":1,"target":"A","message":"hi"}'))
      .toEqual({ kind: 'tell', target: 'A', message: 'hi' });
  });
  it('parses a watch', () => {
    expect(parseOutboxMessage('{"kind":"watch","target":"A","note":"run tests"}'))
      .toEqual({ kind: 'watch', target: 'A', note: 'run tests' });
  });
  it('parses a spawn with and without a base', () => {
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","base":"main","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null });
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'do X', model: null, effort: null, name: null });
  });
  it('parses spawn model/effort/name, lowercasing effort and nulling junk', () => {
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"opus","effort":"MAX","name":"Linehaul"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: 'opus', effort: 'max', name: 'Linehaul' });
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"  ","effort":42,"name":" "}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: null, effort: null, name: null });
  });
  it('parses a rename and rejects blank fields', () => {
    expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"Linehaul fix"}'))
      .toEqual({ kind: 'rename', target: 'wt-1', name: 'Linehaul fix' });
    expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"  "}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"rename","target":"","name":"x"}')).toBeNull();
  });
  it('parses a close and rejects a missing, blank or non-string target', () => {
    expect(parseOutboxMessage('{"kind":"close","target":"wt-1"}'))
      .toEqual({ kind: 'close', target: 'wt-1' });
    expect(parseOutboxMessage('{"ts":1,"kind":"close","target":"Linehaul fix","extra":true}'))
      .toEqual({ kind: 'close', target: 'Linehaul fix' });
    expect(parseOutboxMessage('{"kind":"close"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"close","target":"   "}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"close","target":42}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"close","target":"wt-1"')).toBeNull(); // truncated JSON
  });
  it('parses a personality toggle (no fields)', () => {
    expect(parseOutboxMessage('{"kind":"personality"}')).toEqual({ kind: 'personality' });
  });
  it('rejects malformed / missing fields', () => {
    expect(parseOutboxMessage('not json')).toBeNull();
    expect(parseOutboxMessage('{"kind":"tell","target":"A"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"watch","target":"  ","note":"x"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"bogus"}')).toBeNull();
  });
});

describe('resolveTellTarget', () => {
  it('matches exactly, then case-insensitively, else null', () => {
    expect(resolveTellTarget('A', ['A', 'B'])).toBe('A');
    expect(resolveTellTarget('improver 1', ['Improver 1', 'B'])).toBe('Improver 1');
    expect(resolveTellTarget('ghost', ['A', 'B'])).toBeNull();
  });
});

describe('planClose', () => {
  const floor: CloseCandidate[] = [
    { name: 'Linehaul fix', kind: 'terminal', busy: false },
    { name: 'wt-2', kind: 'terminal', busy: true },
    { name: 'Journal', kind: 'journal', busy: false },
    { name: 'Kane', kind: 'overseer', busy: false },
    { name: 'Kane 2', kind: 'overseer', busy: false },
  ];
  it('resolves a worker exactly, then case-insensitively, and carries its busy state', () => {
    expect(planClose('Linehaul fix', floor)).toEqual({ ok: true, name: 'Linehaul fix', busy: false });
    expect(planClose('linehaul FIX', floor)).toEqual({ ok: true, name: 'Linehaul fix', busy: false });
    expect(planClose('wt-2', floor)).toEqual({ ok: true, name: 'wt-2', busy: true });
  });
  it('refuses an unknown name and lists the live terminals (workers only)', () => {
    const r = planClose('ghost', floor);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('no terminal named "ghost"');
    expect(r.reason).toContain('Linehaul fix, wt-2');
    expect(r.reason).not.toContain('Kane');
    expect(planClose('ghost', [])).toEqual({ ok: false, reason: 'no terminal named "ghost". Live terminals: (none)' });
  });
  it('refuses a journal, by name, with the reason', () => {
    const r = planClose('journal', floor);
    expect(r).toEqual({ ok: false, reason: '"Journal" is a journal, not a worker session — refused' });
  });
  it('refuses an overseer console, including the caller closing itself', () => {
    expect(planClose('Kane', floor)).toEqual({ ok: false, reason: '"Kane" is an overseer console, not a worker session — refused' });
    expect(planClose('kane 2', floor)).toEqual({ ok: false, reason: '"Kane 2" is an overseer console, not a worker session — refused' });
  });
  it('lets a worker win a name it shares with an overseer', () => {
    const f: CloseCandidate[] = [{ name: 'Kane', kind: 'overseer', busy: false }, { name: 'Kane', kind: 'terminal', busy: false }];
    expect(planClose('Kane', f)).toEqual({ ok: true, name: 'Kane', busy: false });
  });
  it('refuses a name that picks out more than one worker instead of guessing', () => {
    const dup: CloseCandidate[] = [{ name: 'A', kind: 'terminal', busy: false }, { name: 'A', kind: 'terminal', busy: true }];
    const r = planClose('A', dup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('matches 2 terminals');
    const cases: CloseCandidate[] = [{ name: 'Foo', kind: 'terminal', busy: false }, { name: 'foo', kind: 'terminal', busy: false }];
    expect(planClose('Foo', cases)).toEqual({ ok: true, name: 'Foo', busy: false }); // exact match is unambiguous
    expect(planClose('FOO', cases).ok).toBe(false); // case-insensitive would be a guess
  });
});

describe('closeResultText', () => {
  it('says when the session was mid-turn, and when watches were dropped', () => {
    expect(closeResultText('wt-1', false)).toMatch(/^closed wt-1 — worktree and branch kept/);
    expect(closeResultText('wt-1', true)).toMatch(/^closed wt-1 \(was mid-turn\) — /);
    expect(closeResultText('wt-1', false, 1)).toContain('dropped 1 watch on it');
    expect(closeResultText('wt-1', false, 2)).toContain('dropped 2 watches on it');
  });
});

describe('slug', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slug('Improver 1')).toBe('improver-1');
    expect(slug('!!!')).toBe('unnamed');
  });
});

describe('formatFloorSnapshot', () => {
  it('renders a header block + fenced recent output', () => {
    const out = formatFloorSnapshot(
      { name: 'Improver 1', repo: 'app', branch: 'wt/main-1', worktreePath: '/w/1', ts: 0 },
      'building...\nok',
    );
    expect(out).toContain('# Improver 1');
    expect(out).toContain('- repo: app');
    expect(out).toContain('- branch: wt/main-1');
    expect(out).toContain('- worktree: /w/1');
    expect(out).toContain('1970-01-01T00:00:00.000Z');
    expect(out).toContain('building...\nok');
  });
});

describe('formatFloorIndex', () => {
  it('lists live terminals with their snapshot filenames', () => {
    const idx = formatFloorIndex([{ id: 2, name: 'Improver 1', repo: 'app', branch: 'wt/main-1' }]);
    expect(idx).toContain('**Improver 1**');
    expect(idx).toContain('2-improver-1.md');
  });
  it('says so when the floor is empty', () => {
    expect(formatFloorIndex([])).toContain('no terminals open');
  });
});

describe('godSystemPrompt', () => {
  const p = godSystemPrompt([{ name: 'app', path: '/repos/app' }], '/coord');
  it('states the non-autonomous overseer stance', () => {
    expect(p).toMatch(/do not run the floor/i);
    expect(p).toMatch(/user drives/i);
    expect(p).toMatch(/never start work|do not start work|only when asked|only on request/i);
  });
  it('tells GOD where to read the floor', () => {
    expect(p).toContain('/coord/floor/INDEX.md');
    expect(p).toContain('/coord/board.md');
    expect(p).toContain('/coord/worktrees.md');
  });
  it('documents cos-coord tell and lists repo paths', () => {
    expect(p).toContain('cos-coord tell');
    expect(p).toContain('/repos/app');
  });
  it('documents the watch, spawn, and rename commands', () => {
    expect(p).toContain('cos-coord watch');
    expect(p).toContain('cos-coord spawn');
    expect(p).toContain('--model');
    expect(p).toContain('--effort low|medium|high|xhigh|max|ultracode');
    expect(p).toContain('--name');
    expect(p).toContain('cos-coord rename');
  });
  it('documents close as work-keeping, and what it refuses', () => {
    expect(p).toContain('cos-coord close "<exact terminal name>"');
    expect(p).toMatch(/KEEPS the worktree and branch/);
    expect(p).toMatch(/refuses journals and overseer consoles/);
    expect(p).toContain('(was mid-turn)');
  });
});

describe('godSystemPrompt self-improvement', () => {
  const repos = [{ name: 'app', path: '/repos/app' }];
  const si = { sourceRepo: 'C:\\dev\\wcc', toolsDir: 'C:\\dev\\kane-tools' };
  it('is absent when not configured', () => {
    expect(godSystemPrompt(repos, '/coord')).not.toContain('SELF-IMPROVEMENT');
  });
  it('names the source repo + tools dir and the guardrails when configured', () => {
    const p = godSystemPrompt(repos, '/coord', 'Kane', si);
    expect(p).toContain('SELF-IMPROVEMENT');
    expect(p).toContain('C:\\dev\\wcc');
    expect(p).toContain('C:\\dev\\kane-tools');
    expect(p).toMatch(/never `git push`/i);
    expect(p).toContain('install-local');
    expect(p).toMatch(/stance is UNCHANGED/);
  });
  it('keeps the overseer stance either way', () => {
    expect(godSystemPrompt(repos, '/coord', 'Kane', si)).toMatch(/do not run the floor/i);
  });
});

describe('parseGodSelfImprove', () => {
  it('accepts sourceRepo with optional toolsDir', () => {
    expect(parseGodSelfImprove({ sourceRepo: 'C:\\x' })).toEqual({ sourceRepo: 'C:\\x', toolsDir: null });
    expect(parseGodSelfImprove({ sourceRepo: 'C:\\x', toolsDir: 'C:\\t' })).toEqual({ sourceRepo: 'C:\\x', toolsDir: 'C:\\t' });
  });
  it('rejects junk without throwing', () => {
    expect(parseGodSelfImprove(undefined)).toBeUndefined();
    expect(parseGodSelfImprove('yes')).toBeUndefined();
    expect(parseGodSelfImprove({ toolsDir: 'C:\\t' })).toBeUndefined();
    expect(parseGodSelfImprove({ sourceRepo: '   ' })).toBeUndefined();
  });
});

describe('EFFORT_LEVELS', () => {
  it('lists the six claude CLI effort levels, ultracode last', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  });
});

describe('remapWatchers', () => {
  it('retargets only the renamed terminal, preserving notes', () => {
    const ws = [{ target: 'A', note: 'x' }, { target: 'B', note: 'y' }];
    expect(remapWatchers(ws, 'A', 'C')).toEqual([{ target: 'C', note: 'x' }, { target: 'B', note: 'y' }]);
    expect(remapWatchers(ws, 'Z', 'C')).toEqual(ws);
  });
});

describe('godSystemPrompt folder targets', () => {
  it('marks plain-folder targets in the roster so Kane does not offer them a --base', () => {
    const p = godSystemPrompt([
      { name: 'app', path: '/repos/app' },
      { name: 'notes', path: '/notes', folder: true },
    ], '/coord');
    expect(p).toContain('- notes → /notes   [plain folder — no git]');
    expect(p).toContain('- app → /repos/app\n'); // git repos stay unmarked
    expect(p).toContain('--base is ignored');
  });
});
