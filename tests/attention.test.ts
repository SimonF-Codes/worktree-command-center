import { describe, it, expect } from 'vitest';
import { classifyAttention, actionCount, classifyOne, attentionKind } from '../src/terminals/attention';

const t = (id: number, output: string, idle = false, name = `t${id}`, repo = 'app') => ({ id, name, repo, output, idle });

describe('classifyAttention', () => {
  it('classifies by precedence prompt > menu > errored > idle', () => {
    const items = classifyAttention([
      t(1, 'Continue? (y/n)'),
      t(2, 'Enter to select · ↑/↓ to navigate · Esc to cancel'),
      t(3, 'Error: boom'),
      t(4, 'all good', true),
    ]);
    expect(items.map((i) => [i.id, i.state])).toEqual([[1, 'prompt'], [2, 'menu'], [3, 'errored'], [4, 'idle']]);
  });
  it('prompt wins even when the output also looks errored', () => {
    expect(classifyAttention([t(1, 'Error: boom\nContinue? (y/n)')])[0].state).toBe('prompt');
  });
  it('omits busy tiles with nothing to flag', () => {
    expect(classifyAttention([t(1, 'building…', false)])).toEqual([]);
  });
});

describe('actionCount', () => {
  it('counts prompt/menu/errored but not idle', () => {
    const items = classifyAttention([t(1, 'Continue? (y/n)'), t(2, 'ok', true), t(3, 'Error: x')]);
    expect(actionCount(items)).toBe(2);
  });
});

describe('classifyOne', () => {
  it('applies prompt > menu > errored > idle, else running', () => {
    expect(classifyOne('Continue? (y/n)', false)).toBe('prompt');
    expect(classifyOne('Enter to select · ↑/↓ to navigate · Esc to cancel', false)).toBe('menu');
    expect(classifyOne('Error: boom', false)).toBe('errored');
    expect(classifyOne('all good', true)).toBe('idle');
    expect(classifyOne('building…', false)).toBe('running');
  });
});

describe('attentionKind', () => {
  it('buckets states into input / help / done, null for running', () => {
    expect(attentionKind('prompt')).toBe('input');
    expect(attentionKind('menu')).toBe('input');
    expect(attentionKind('errored')).toBe('help');
    expect(attentionKind('idle')).toBe('done');
    expect(attentionKind('running')).toBeNull();
  });
});
