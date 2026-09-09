import { describe, it, expect } from 'vitest';
import { looksLikeMenu, looksErrored, looksBusy, looksDelivered, normalizeForMatch } from '../src/terminals/prompt-detect';

describe('looksLikeMenu', () => {
  // The real footer Claude Code renders under a single- or multi-select menu.
  const footer = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

  it('detects an interactive selection menu by its navigation footer', () => {
    expect(looksLikeMenu(`1. [ ] Time dropdown too long\n2. [ ] Date + time feel disjointed\n\n${footer}`)).toBe(true);
  });

  it('detects each navigation-hint phrase on its own', () => {
    expect(looksLikeMenu('use ↑/↓ to navigate the list')).toBe(true);
    expect(looksLikeMenu('press Esc to cancel')).toBe(true);
    expect(looksLikeMenu('Enter to select')).toBe(true);
    expect(looksLikeMenu('enter to toggle')).toBe(true);
  });

  it('does NOT fire on normal output or prose that merely says "navigate"', () => {
    expect(looksLikeMenu('Running the eval now, this will take a bit.')).toBe(false);
    expect(looksLikeMenu('let me navigate to the src directory and read the file')).toBe(false);
    expect(looksLikeMenu('Done. Results saved to ab_results/run.log')).toBe(false);
    expect(looksLikeMenu('')).toBe(false);
  });
});

describe('looksErrored', () => {
  it('fires on common failure markers', () => {
    expect(looksErrored('Traceback (most recent call last):')).toBe(true);
    expect(looksErrored('Error: ENOENT: no such file')).toBe(true);
    expect(looksErrored('✗ 3 tests failed')).toBe(true);
    expect(looksErrored("'claude' is not recognized as a command")).toBe(true);
    expect(looksErrored('process exited with code 1')).toBe(true);
  });
  it('does not fire on normal output or empty', () => {
    expect(looksErrored('Done. Results saved to run.log')).toBe(false);
    expect(looksErrored('Running the build now…')).toBe(false);
    expect(looksErrored('')).toBe(false);
  });
});

describe('looksBusy', () => {
  it('fires while a turn is running (the "esc to interrupt" hint)', () => {
    expect(looksBusy('✻ Baking… (12s · esc to interrupt)')).toBe(true);
    expect(looksBusy('⏵⏵ bypass permissions on · esc to interrupt · ← for agents')).toBe(true);
    expect(looksBusy('ESC TO INTERRUPT')).toBe(true);
  });
  it('does NOT fire on an idle prompt bar or normal output', () => {
    expect(looksBusy('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')).toBe(false);
    expect(looksBusy('Done. Anything else?')).toBe(false);
    expect(looksBusy('')).toBe(false);
  });
});

describe('looksDelivered', () => {
  it('finds the sent text sitting plainly in recent output', () => {
    expect(looksDelivered('some earlier line\n> please run the tests\nworking…', 'please run the tests')).toBe(true);
  });
  it('finds it even when the terminal wraps at a space boundary', () => {
    expect(looksDelivered('> please run the\ntests and report back', 'please run the tests and report back')).toBe(true);
  });
  // Regression (2026-09-09): every `tell` was reporting failure while actually delivering.
  // Root cause was here — Claude Code's real TUI hard-wraps a long line MID-WORD, with no space
  // or hyphen at the break, just a two-space-indented continuation row. The old check collapsed
  // whitespace to a single space, which turns a mid-word break into a phantom space that was
  // never in the sent text ("coordi" + "nation" -> "coordi nation" != "coordination").
  it('finds it when the terminal hard-wraps MID-WORD, with no space at the break', () => {
    expect(looksDelivered('> abc\n  def and the rest', 'abcdef and the rest')).toBe(true);
  });
  it('reproduces the exact regression: a real captured Claude Code transcript, mid-task', () => {
    // Verbatim from a live floor snapshot (brain-2-0/floor/2-b2-news.md, 2026-09-09) for the
    // exact terminal the bug report named — a busy session ("esc to interrupt"), input box empty
    // (the message already queued/echoed above), the sent line wrapped mid-word twice (Kane's
    // retry after the false failure duplicated it, which is its own part of this incident).
    const recentOutput = [
      '> New task. Read C:\\Users\\fridl\\AppData\\Roaming\\worktree-command-center\\.coordi',
      '  nation\\brain-2-0\\briefs\\mail-backend.md and do it.',
      '● Wired task dispatch for unstamped tasks; test suite added',
      '  ⎿  $ cd "C:\\dev\\.claude-worktrees\\Brain_2.0\\wt-master-6" && sed -n \'495,535p\'',
      '     node_modules/imapflow/dist/cjs/types.d.ts',
      '· Smooshing… (7m 24s · almost done thinking with high effort)',
      '────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…',
    ].join('\n');
    const sent = 'New task. Read C:\\Users\\fridl\\AppData\\Roaming\\worktree-command-center\\.coordination\\brain-2-0\\briefs\\mail-backend.md and do it.';
    expect(looksDelivered(recentOutput, sent)).toBe(true);
  });
  it('reports NOT delivered when the screen shows no trace of it at all (e.g. eaten by a compact)', () => {
    expect(looksDelivered('✻ Compacting conversation… (esc to interrupt)', 'please run the tests')).toBe(false);
    expect(looksDelivered('', 'please run the tests')).toBe(false);
  });
  it('only matches on a bounded prefix, so a long message is not sunk by trailing wrap noise', () => {
    const sent = 'x'.repeat(200);
    expect(looksDelivered(`> ${'x'.repeat(90)}`, sent)).toBe(true);
  });
  it('treats an empty/whitespace-only line as trivially delivered (nothing to find)', () => {
    expect(looksDelivered('anything at all', '   ')).toBe(true);
  });
});

describe('normalizeForMatch', () => {
  it('collapses whitespace (incl. newlines) to single spaces and trims', () => {
    expect(normalizeForMatch('  a\n  b\tc  ')).toBe('a b c');
  });
});
