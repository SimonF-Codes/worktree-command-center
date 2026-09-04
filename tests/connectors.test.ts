import { describe, it, expect } from 'vitest';
import {
  parseConnectors, parseConnectorRequest, evaluateConnectorRequest, resolveConnectorTellTarget,
  receiptFilename, isReceiptStale, RECEIPT_MAX_AGE_MS, MAX_TELL_MESSAGE_LEN,
} from '../src/terminals/connectors';

const validSpawn = JSON.stringify({
  v: 1, id: 'req-1', connector: 'brain-2-0', sentMs: 1000, kind: 'spawn',
  repo: 'app', base: 'main', task: 'do X', model: 'opus', effort: 'MAX', name: 'bx-a1--thing',
});

describe('parseConnectors', () => {
  it('accepts well-formed entries, dropping malformed ones', () => {
    expect(parseConnectors([
      { id: 'brain-2-0', label: 'Brain 2.0' },
      { id: 'Bad Id', label: 'x' },      // fails the slug pattern
      { id: 'no-label' },                 // missing label
      'not an object',
      { id: 'ok', label: '  ' },          // blank label
    ])).toEqual([{ id: 'brain-2-0', label: 'Brain 2.0' }]);
  });
  it('never throws on junk', () => {
    expect(parseConnectors(undefined)).toEqual([]);
    expect(parseConnectors('nope')).toEqual([]);
    expect(parseConnectors({})).toEqual([]);
  });
});

describe('parseConnectorRequest', () => {
  it('parses a well-formed spawn, lowercasing effort and nulling blanks', () => {
    expect(parseConnectorRequest(validSpawn)).toEqual({
      ok: true,
      request: {
        v: 1, id: 'req-1', connector: 'brain-2-0', sentMs: 1000, kind: 'spawn',
        repo: 'app', base: 'main', task: 'do X', model: 'opus', effort: 'max', name: 'bx-a1--thing',
      },
    });
  });
  it('defaults base/model/effort/name to null when omitted', () => {
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'r2', connector: 'c', sentMs: 1, kind: 'spawn', repo: 'app', task: 'x' }));
    expect(r).toEqual({ ok: true, request: { v: 1, id: 'r2', connector: 'c', sentMs: 1, kind: 'spawn', repo: 'app', base: null, task: 'x', model: null, effort: null, name: null } });
  });

  it('rejects invalid JSON with no id to key a receipt on', () => {
    expect(parseConnectorRequest('not json')).toEqual({ ok: false, id: null, reason: expect.stringContaining('malformed') });
    expect(parseConnectorRequest('null')).toEqual({ ok: false, id: null, reason: expect.stringContaining('malformed') });
    expect(parseConnectorRequest('[]')).toEqual({ ok: false, id: null, reason: expect.stringContaining('malformed') });
  });
  it('rejects a missing id with no id to key a receipt on', () => {
    const r = parseConnectorRequest(JSON.stringify({ connector: 'c', kind: 'spawn' }));
    expect(r.ok).toBe(false);
    expect((r as { id: string | null }).id).toBeNull();
  });
  it('rejects a malformed envelope but still recovers the id, so a receipt can name it', () => {
    const r = parseConnectorRequest(JSON.stringify({ id: 'req-2', kind: 'spawn' })); // missing connector/v/sentMs
    expect(r).toEqual({ ok: false, id: 'req-2', reason: expect.stringContaining('malformed') });
  });
  it('rejects a malformed spawn body (missing repo/task) with the id recovered', () => {
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-3', connector: 'c', sentMs: 1, kind: 'spawn' }));
    expect(r).toEqual({ ok: false, id: 'req-3', reason: expect.stringContaining('malformed spawn') });
  });

  it('rejects every kind but spawn/tell — the permitted-verb boundary', () => {
    for (const kind of ['watch', 'rename', 'personality', 'bogus']) {
      const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-4', connector: 'c', sentMs: 1, kind }));
      expect(r).toEqual({ ok: false, id: 'req-4', reason: expect.stringContaining('not permitted for connectors') });
    }
  });
  it('rejects a missing kind the same way as an unpermitted one', () => {
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-5', connector: 'c', sentMs: 1 }));
    expect(r).toEqual({ ok: false, id: 'req-5', reason: expect.stringContaining('not permitted for connectors') });
  });

  it('parses a well-formed tell', () => {
    const r = parseConnectorRequest(JSON.stringify({
      v: 1, id: 'req-t1', connector: 'brain-2-0', sentMs: 1, kind: 'tell', terminal: 'b2-drag', message: 'do the thing',
    }));
    expect(r).toEqual({ ok: true, request: { v: 1, id: 'req-t1', connector: 'brain-2-0', sentMs: 1, kind: 'tell', terminal: 'b2-drag', message: 'do the thing' } });
  });
  it('rejects a tell missing terminal or message, with the id recovered', () => {
    expect(parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-t2', connector: 'c', sentMs: 1, kind: 'tell', message: 'hi' })))
      .toEqual({ ok: false, id: 'req-t2', reason: expect.stringContaining('malformed tell') });
    expect(parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-t3', connector: 'c', sentMs: 1, kind: 'tell', terminal: 'x' })))
      .toEqual({ ok: false, id: 'req-t3', reason: expect.stringContaining('malformed tell') });
  });
  it('rejects a tell message over the length cap', () => {
    const message = 'x'.repeat(MAX_TELL_MESSAGE_LEN + 1);
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-t4', connector: 'c', sentMs: 1, kind: 'tell', terminal: 'x', message }));
    expect(r).toEqual({ ok: false, id: 'req-t4', reason: expect.stringContaining('too long') });
  });
  it('accepts a tell message exactly at the length cap', () => {
    const message = 'x'.repeat(MAX_TELL_MESSAGE_LEN);
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-t5', connector: 'c', sentMs: 1, kind: 'tell', terminal: 'x', message }));
    expect(r.ok).toBe(true);
  });
});

describe('resolveConnectorTellTarget', () => {
  const terminals = [
    { name: 'b2-drag', isJournal: false },
    { name: 'B2-Other', isJournal: false },
    { name: 'notes', isJournal: true },
  ];

  it('resolves an exact match', () => {
    expect(resolveConnectorTellTarget('b2-drag', terminals)).toEqual({ ok: true, name: 'b2-drag' });
  });
  it('resolves a unique case-insensitive match', () => {
    expect(resolveConnectorTellTarget('B2-DRAG', terminals)).toEqual({ ok: true, name: 'b2-drag' });
  });
  it('rejects with a reason when no terminal matches', () => {
    const r = resolveConnectorTellTarget('ghost', terminals);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no such terminal "ghost"') });
  });
  it('rejects an ambiguous case-insensitive match rather than guessing', () => {
    const r = resolveConnectorTellTarget('B2-OTHER', [{ name: 'B2-Other', isJournal: false }, { name: 'b2-other', isJournal: false }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('ambiguous') });
  });
  it('rejects an exact match that is a journal, not a terminal', () => {
    const r = resolveConnectorTellTarget('notes', terminals);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('journal tile') });
  });
});

describe('evaluateConnectorRequest', () => {
  const opts = { connectorId: 'brain-2-0', registeredConnectorIds: ['brain-2-0'], knownRepoNames: ['app', 'ChessEdu'] };

  it('accepts a valid, registered, known-repo spawn', () => {
    const out = evaluateConnectorRequest(validSpawn, opts);
    expect(out.status).toBe('accepted');
    expect(out).toMatchObject({ id: 'req-1', request: { repo: 'app', task: 'do X' } });
  });

  it('rejects an unregistered connector before it can learn the repo list', () => {
    const out = evaluateConnectorRequest(validSpawn, { ...opts, registeredConnectorIds: [] });
    expect(out).toEqual({ status: 'rejected', id: 'req-1', reason: expect.stringContaining('not registered') });
  });

  it('rejects an unknown repo', () => {
    const req = JSON.stringify({ v: 1, id: 'req-6', connector: 'brain-2-0', sentMs: 1, kind: 'spawn', repo: 'ghost-repo', task: 'x' });
    const out = evaluateConnectorRequest(req, opts);
    expect(out).toEqual({ status: 'rejected', id: 'req-6', reason: expect.stringContaining('unknown repo "ghost-repo"') });
  });

  it('rejects a permitted-verb violation before the connector is even checked', () => {
    const req = JSON.stringify({ v: 1, id: 'req-7', connector: 'brain-2-0', sentMs: 1, kind: 'rename', target: 'A', name: 'B' });
    const out = evaluateConnectorRequest(req, { ...opts, registeredConnectorIds: [] }); // unregistered too
    expect(out).toEqual({ status: 'rejected', id: 'req-7', reason: expect.stringContaining('not permitted for connectors') });
  });

  it('rejects an invalid effort', () => {
    const req = JSON.stringify({ v: 1, id: 'req-8', connector: 'brain-2-0', sentMs: 1, kind: 'spawn', repo: 'app', task: 'x', effort: 'nonsense' });
    const out = evaluateConnectorRequest(req, opts);
    expect(out).toEqual({ status: 'rejected', id: 'req-8', reason: expect.stringContaining('invalid effort') });
  });

  it('rejects a malformed envelope with no id to attach', () => {
    const out = evaluateConnectorRequest('not json', opts);
    expect(out).toEqual({ status: 'rejected', id: null, reason: expect.stringContaining('malformed') });
  });

  const tellOpts = { ...opts, liveTerminals: [{ name: 'b2-drag', isJournal: false }, { name: 'notes', isJournal: true }] };
  const tellReq = (terminal: string) => JSON.stringify({ v: 1, id: 'req-t', connector: 'brain-2-0', sentMs: 1, kind: 'tell', terminal, message: 'hi' });

  it('accepts a tell to a live terminal, normalizing the resolved name', () => {
    const out = evaluateConnectorRequest(tellReq('B2-DRAG'), tellOpts);
    expect(out).toEqual({ status: 'accepted', id: 'req-t', request: { v: 1, id: 'req-t', connector: 'brain-2-0', sentMs: 1, kind: 'tell', terminal: 'b2-drag', message: 'hi' } });
  });
  it('rejects a tell to an unregistered connector before the roster is even consulted', () => {
    const out = evaluateConnectorRequest(tellReq('b2-drag'), { ...tellOpts, registeredConnectorIds: [] });
    expect(out).toEqual({ status: 'rejected', id: 'req-t', reason: expect.stringContaining('not registered') });
  });
  it('rejects a tell to a terminal that is not live', () => {
    const out = evaluateConnectorRequest(tellReq('ghost'), tellOpts);
    expect(out).toEqual({ status: 'rejected', id: 'req-t', reason: expect.stringContaining('no such terminal') });
  });
  it('rejects a tell to a journal tile', () => {
    const out = evaluateConnectorRequest(tellReq('notes'), tellOpts);
    expect(out).toEqual({ status: 'rejected', id: 'req-t', reason: expect.stringContaining('journal tile') });
  });
});

describe('receiptFilename', () => {
  it('keeps a plain id intact, appending .json', () => {
    expect(receiptFilename('req-1')).toBe('req-1.json');
  });
  it('sanitizes anything that could escape the receipts directory', () => {
    expect(receiptFilename('../../etc/passwd')).not.toContain('/');
    expect(receiptFilename('../../etc/passwd')).not.toContain('..');
    expect(receiptFilename('a/b\\c')).toBe('a_b_c.json');
  });
  it('never produces an empty basename', () => {
    expect(receiptFilename('')).toBe('_.json');
    expect(receiptFilename('...')).toBe('___.json');
  });
});

describe('isReceiptStale', () => {
  it('is false at and just under the age boundary, true just over it', () => {
    const handledMs = 1_000_000;
    expect(isReceiptStale(handledMs, handledMs)).toBe(false);
    expect(isReceiptStale(handledMs, handledMs + RECEIPT_MAX_AGE_MS)).toBe(false);
    expect(isReceiptStale(handledMs, handledMs + RECEIPT_MAX_AGE_MS + 1)).toBe(true);
  });
  it('honours a custom max age', () => {
    expect(isReceiptStale(0, 100, 50)).toBe(true);
    expect(isReceiptStale(0, 50, 50)).toBe(false);
  });
});
