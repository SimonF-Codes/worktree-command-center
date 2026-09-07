import { describe, it, expect, vi, afterEach } from 'vitest';
import { ctrlClickActivator, openExternalUrl, revealInFileManager } from '../src/terminals/links';

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; });

const ev = (mods: { ctrlKey?: boolean; metaKey?: boolean }) => mods as unknown as MouseEvent;

describe('ctrlClickActivator', () => {
  it('opens the url only when Ctrl or Cmd is held', () => {
    const open = vi.fn();
    const activate = ctrlClickActivator(open);
    activate(ev({ ctrlKey: true }), 'http://localhost:5173');
    activate(ev({ metaKey: true }), 'http://localhost:5050');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'http://localhost:5173');
    expect(open).toHaveBeenNthCalledWith(2, 'http://localhost:5050');
  });

  it('does nothing on a plain click (so selection/click is unaffected)', () => {
    const open = vi.fn();
    ctrlClickActivator(open)(ev({}), 'http://localhost:3000');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('openExternalUrl', () => {
  it('opens via Electron shell.openExternal when available', () => {
    const openExternal = vi.fn();
    const winOpen = vi.fn();
    g.window = { open: winOpen, require: (m: string) => (m === 'electron' ? { shell: { openExternal } } : {}) };
    openExternalUrl('https://example.com');
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
    expect(winOpen).not.toHaveBeenCalled(); // shell path returns before the window.open fallback
  });

  it('falls back to window.open when Electron shell is unavailable', () => {
    const winOpen = vi.fn();
    g.window = { open: winOpen };
    openExternalUrl('https://example.com');
    expect(winOpen).toHaveBeenCalledWith('https://example.com', '_blank');
  });
});

describe('revealInFileManager', () => {
  it('reveals via Electron shell.openPath and reports success', () => {
    const openPath = vi.fn(() => Promise.resolve(''));
    g.window = { require: (m: string) => (m === 'electron' ? { shell: { openPath } } : {}) };
    expect(revealInFileManager('/some/path')).toBe(true);
    expect(openPath).toHaveBeenCalledWith('/some/path');
  });

  it('returns false when no Electron shell is available', () => {
    g.window = {};
    expect(revealInFileManager('/some/path')).toBe(false);
  });
});
