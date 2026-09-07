import { describe, it, expect, afterEach, vi } from 'vitest';
import { readClipboardText, writeClipboardText } from '../src/terminals/clipboard';

const g = globalThis as { window?: unknown; navigator?: unknown };

afterEach(() => {
  delete g.window;
  // vitest's node env owns navigator; only remove it if this test installed one.
  if ((g as { __wccNav?: boolean }).__wccNav) { delete g.navigator; delete (g as { __wccNav?: boolean }).__wccNav; }
});

function setNavigator(nav: unknown) {
  Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  (g as { __wccNav?: boolean }).__wccNav = true;
}

describe('writeClipboardText', () => {
  it('prefers the wcc IPC bridge when present', () => {
    const clipboardWrite = vi.fn(() => Promise.resolve());
    g.window = { wcc: { clipboardWrite } };
    writeClipboardText('hello');
    expect(clipboardWrite).toHaveBeenCalledWith('hello');
  });

  it('falls back to electron clipboard.writeText when there is no bridge', () => {
    const writeText = vi.fn();
    g.window = { require: (m: string) => (m === 'electron' ? { clipboard: { writeText } } : {}) };
    writeClipboardText('copy me');
    expect(writeText).toHaveBeenCalledWith('copy me');
  });

  it('never throws when nothing is available', () => {
    g.window = {};
    expect(() => writeClipboardText('x')).not.toThrow();
  });
});

describe('readClipboardText', () => {
  it('reads via the wcc IPC bridge when present', async () => {
    g.window = { wcc: { clipboardRead: () => Promise.resolve('from-bridge') } };
    expect(await readClipboardText()).toBe('from-bridge');
  });

  it('falls back to electron clipboard.readText', async () => {
    g.window = { require: (m: string) => (m === 'electron' ? { clipboard: { readText: () => 'from-electron' } } : {}) };
    expect(await readClipboardText()).toBe('from-electron');
  });

  it("returns '' (never rejects) when no source is available", async () => {
    g.window = {};
    setNavigator(undefined);
    expect(await readClipboardText()).toBe('');
  });
});
