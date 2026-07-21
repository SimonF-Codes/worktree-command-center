import { describe, it, expect } from 'vitest';
import { decodeOsc52 } from '../src/terminals/clipboard-osc';

// Build the payload xterm hands the OSC 52 handler: `Ps;Pd` (identifier `52` already stripped).
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const write = (sel: string, text: string) => `${sel};${b64(text)}`;

describe('decodeOsc52', () => {
  it('decodes a clipboard write to the original text', () => {
    expect(decodeOsc52(write('c', 'hello world'))).toBe('hello world');
  });

  it('round-trips multi-byte UTF-8 (not Latin-1 mojibake)', () => {
    const s = 'café — 音楽 🎵';
    expect(decodeOsc52(write('c', s))).toBe(s);
  });

  it('accepts an empty selection field (52;;<b64>)', () => {
    expect(decodeOsc52(write('', 'x'))).toBe('x');
  });

  it('refuses the read/query form (Pd === "?") so the app cannot read the clipboard', () => {
    expect(decodeOsc52('c;?')).toBeNull();
  });

  it('ignores an empty data field', () => {
    expect(decodeOsc52('c;')).toBeNull();
  });

  it('ignores a malformed payload with no selection/data separator', () => {
    expect(decodeOsc52('notbase64')).toBeNull();
  });

  it('ignores invalid base64', () => {
    expect(decodeOsc52('c;@@@not-base64@@@')).toBeNull();
  });
});
