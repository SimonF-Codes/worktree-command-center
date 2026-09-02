import { describe, it, expect } from 'vitest';
import {
  parseConnectors, parseConnectorRequest, evaluateConnectorRequest,
  receiptFilename, isReceiptStale, RECEIPT_MAX_AGE_MS,
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

  it('rejects every kind but spawn — the permitted-verb boundary', () => {
    for (const kind of ['tell', 'watch', 'rename', 'personality', 'bogus']) {
      const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-4', connector: 'c', sentMs: 1, kind }));
      expect(r).toEqual({ ok: false, id: 'req-4', reason: expect.stringContaining('not permitted for connectors') });
    }
  });
  it('rejects a missing kind the same way as an unpermitted one', () => {
    const r = parseConnectorRequest(JSON.stringify({ v: 1, id: 'req-5', connector: 'c', sentMs: 1 }));
    expect(r).toEqual({ ok: false, id: 'req-5', reason: expect.stringContaining('not permitted for connectors') });
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

  it('rejects a permitted-verb violation with the connector still unresolved', () => {
    const req = JSON.stringify({ v: 1, id: 'req-7', connector: 'brain-2-0', sentMs: 1, kind: 'tell', target: 'A', message: 'hi' });
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
