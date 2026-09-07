import { describe, it, expect } from 'vitest';
import { parseUsage } from '../src/terminals/usage-parse';

// Spaced form, close to how /usage renders.
const SPACED = [
  'Current session  ██████▍ 28% used   Resets 3:50am (America/New_York)',
  'Current week (all models)  ███ 6% used   Resets Jun 15, 12am (America/New_York)',
  'Current week (Sonnet only) ▌ 1% used  Resets Jun 14, 11:59pm (America/New_York)',
  'Current week (Fable)  ██▌ 12% used   Resets Jun 15, 12am (America/New_York)',
  'Usage credits  ██████████▎ 92% used   $13.88 / $15.00 spent · Resets Jul 1 (America/New_York)',
].join('\n');

// Verbatim from a real stripped TUI capture: cell-positioned redraws can drop characters
// mid-word in the Fable region ("Rests", "Amerca") — parsing must tolerate it.
const REAL_FABLE =
  'Current session███████████████████████████████████████▌79%usedResets 1:40pm (America/New_York)' +
  'Current week (all models) ███████████████████████████ 54% usedResets Jul 20, 12am (America/New_York)\n' +
  'Current week (Fable)███████████████████████████████████▌               71% used                  Rests Jul 20, 12am (Amerca/New_York)';

// Verbatim from a real stripped 2.1.211 capture: /usage now renders inside the tabbed
// Settings view. A promo line sits between the week and Fable rows, and the Fable label's
// "Current week (" prefix is painted as a separate cell run — only "Fable)" survives
// adjacent to its number in the stripped stream.
const REAL_TABBED_SETTINGS =
  'Settings' +
  'Status   Config   Usage Stats' +
  'Session' +
  'Total cost:            $0.0000' +
  'Usage:                 0 input, 0 output, 0 cache read, 0 cache write\n' +
  'Current session████████████████████████████████▌65%usedResets 7pm(America/New_York)\n' +
  'Current week (all models)███▌7%usedResets Jul 25, 12am (America/New_York)' +
  '+50% weekly limits promo through Aug 19 · clau.de/cc-50-promoFable)███▌13% used\n' +
  "What's contributing to your limits usage?Approximate, based on local sessions on this machine\n" +
  'Usage creditsUsag credits are off · /usage-credits to turn them on';

// Collapsed form, like a stripped TUI buffer where spacing escapes were removed.
const COLLAPSED =
  'Currentsession██▍28%usedResets3:50am(America/New_York)Currentweek(allmodels)███6%usedResetsJun15,12am(America/New_York)Currentweek(Sonetnly)▌1%usedResetsJun14';

describe('parseUsage', () => {
  it('extracts session + weekly + credits from the spaced form', () => {
    const r = parseUsage(SPACED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am (America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun 15, 12am (America/New_York)');
    expect(r.creditsPct).toBe(92);
    expect(r.creditsSpent).toBe('$13.88 / $15.00');
    expect(r.creditsReset).toBe('Jul 1 (America/New_York)');
  });
  it('is tolerant of collapsed spacing', () => {
    const r = parseUsage(COLLAPSED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am(America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun15,12am(America/New_York)');
  });
  it('does not confuse the Sonnet-only week with the all-models week', () => {
    expect(parseUsage(SPACED).weekPct).toBe(6); // not 1
  });
  it('extracts the Fable week without confusing the other sections', () => {
    const r = parseUsage(SPACED);
    expect(r.fablePct).toBe(12);
    expect(r.fableReset).toBe('Jun 15, 12am (America/New_York)');
    expect(r.weekPct).toBe(6);   // not 12
    expect(r.sessionPct).toBe(28);
  });
  it('parses a real capture where the Fable region stripped dirty ("Rests"/"Amerca")', () => {
    const r = parseUsage(REAL_FABLE);
    expect(r.sessionPct).toBe(79);
    expect(r.weekPct).toBe(54);
    expect(r.fablePct).toBe(71);
    expect(r.fableReset).toBe('Jul 20, 12am (Amerca/New_York)');
  });
  it('parses the 2.1.211 tabbed Settings view (split Fable label, promo line, credits off)', () => {
    const r = parseUsage(REAL_TABBED_SETTINGS);
    expect(r.sessionPct).toBe(65);
    expect(r.sessionReset).toBe('7pm(America/New_York)');
    expect(r.weekPct).toBe(7);      // not 50 (promo) and not 13 (Fable)
    expect(r.weekReset).toBe('Jul 25, 12am (America/New_York)');
    expect(r.fablePct).toBe(13);    // label prefix painted separately — only "Fable)" is adjacent
    expect(r.fableReset).toBeNull(); // the tabbed view doesn't repeat the boundary on the Fable row
    expect(r.creditsPct).toBeNull(); // credits are off — no bar to read
    expect(r.creditsSpent).toBeNull();
  });
  it('returns nulls for junk, never throws', () => {
    const empty = { sessionPct: null, sessionReset: null, weekPct: null, weekReset: null, fablePct: null, fableReset: null, creditsPct: null, creditsSpent: null, creditsReset: null };
    expect(parseUsage('nothing useful here')).toEqual(empty);
    expect(parseUsage('')).toEqual(empty);
  });
});
