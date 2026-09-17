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
  it('finds it even when the terminal line-wrapped it across rows', () => {
    expect(looksDelivered('> please run the\ntests and report back', 'please run the tests and report back')).toBe(true);
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
