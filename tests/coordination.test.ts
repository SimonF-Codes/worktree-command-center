import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parseBoardLine, formatBoardLine, lockStatus, mergeEvents, isEvent, isChatPost, parseChatLine } from '../src/terminals/coordination';
const require = createRequire(import.meta.url);
const core = require('../pty-sidecar/coord-core.cjs');

describe('coordination.ts', () => {
  it('round-trips a board line', () => {
    const e = { ts: 5, terminal: 'A', resource: 'r', status: 'START' as const, detail: 'x' };
    expect(parseBoardLine(formatBoardLine(e))).toEqual(e);
  });
  it('lockStatus matches free/held/stale', () => {
    expect(lockStatus(null, 10)).toBe('free');
    expect(lockStatus({ ts: 0, ttlMs: 100 }, 50)).toBe('held');
    expect(lockStatus({ ts: 0, ttlMs: 100 }, 200)).toBe('stale');
  });
  it('mergeEvents sorts newest first', () => {
    expect(mergeEvents([{ ts: 1 }, { ts: 9 }] as never).map((e) => (e as { ts: number }).ts)).toEqual([9, 1]);
  });
  it('isEvent discriminates a parsed board event from a raw line', () => {
    const parsed = parseBoardLine('123\ttermA\tr\tSTART\tgo')!;
    const raw = parseBoardLine('totally unstructured line')!;
    expect(isEvent(parsed)).toBe(true);
    expect(isEvent(raw)).toBe(false);
    if (isEvent(parsed)) expect(parsed.status).toBe('START'); // narrows to BoardEvent
  });
  it('isChatPost discriminates a parsed chat post from a raw line', () => {
    const post = parseChatLine('7\ttermA\thello there')!;
    const raw = parseChatLine('no tabs here')!;
    expect(isChatPost(post)).toBe(true);
    expect(isChatPost(raw)).toBe(false);
    if (isChatPost(post)) expect(post.message).toBe('hello there'); // narrows to ChatPost
  });
});

describe('drift: TS mirror matches coord-core.cjs', () => {
  const lines = [
    '123\ttermA\tpaper-trader:db\tSTART\tA/B replay',
    '200\ttermB\t-\tNOTE\treplay done',
    'totally unstructured line',
  ];
  it('parses identically', () => {
    for (const l of lines) expect(parseBoardLine(l)).toEqual(core.parseBoardLine(l));
  });
});
