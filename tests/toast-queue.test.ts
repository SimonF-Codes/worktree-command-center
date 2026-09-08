import { describe, it, expect } from 'vitest';
import {
  emptyToasts, pushToast, expireToasts, dismissToast, holdToast, overflowCount,
  toSeverity, MAX_VISIBLE, DURATION, type ToastState,
} from '../src/ui/toast-queue';

const T0 = 1_000_000;

/** Push a list of messages at the same instant. */
function pushAll(s: ToastState, msgs: [string, Parameters<typeof pushToast>[2]][], now = T0): ToastState {
  return msgs.reduce((acc, [m, v]) => pushToast(acc, m, v, now), s);
}

describe('toSeverity', () => {
  it('defaults to info when no variant is given', () => {
    expect(toSeverity(undefined)).toBe('info');
  });

  it('maps the attention aliases onto real severities', () => {
    expect(toSeverity('done')).toBe('success');
    expect(toSeverity('help')).toBe('error');
    expect(toSeverity('input')).toBe('warn');
  });

  it('passes the real severities through untouched', () => {
    expect(toSeverity('error')).toBe('error');
    expect(toSeverity('success')).toBe('success');
  });
});

describe('visible cap', () => {
  it('shows up to three toasts', () => {
    const s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info']]);
    expect(s.visible).toHaveLength(3);
    expect(overflowCount(s)).toBe(0);
  });

  it('queues everything past three rather than showing it', () => {
    const s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info'], ['d', 'info'], ['e', 'info']]);
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    expect(overflowCount(s)).toBe(2);
    expect(s.visible.map((t) => t.msg)).toEqual(['a', 'b', 'c']);
  });

  it('promotes a queued toast when a visible one expires', () => {
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info'], ['d', 'info']]);
    s = expireToasts(s, T0 + DURATION.info + 1);
    expect(s.visible.map((t) => t.msg)).toEqual(['d']);
    expect(overflowCount(s)).toBe(0);
  });

  it('gives a promoted toast its full lifetime, not the leftover of its wait', () => {
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info'], ['d', 'info']]);
    const promotedAt = T0 + DURATION.info + 1;
    s = expireToasts(s, promotedAt);
    expect(s.visible[0]!.expiresAt).toBe(promotedAt + DURATION.info);
  });
});

describe('priority promotion', () => {
  it('promotes a queued error ahead of queued info, regardless of arrival order', () => {
    let s = pushAll(emptyToasts(), [
      ['a', 'info'], ['b', 'info'], ['c', 'info'],   // fill the three slots
      ['queued-info', 'info'], ['queued-error', 'error'],
    ]);
    expect(overflowCount(s)).toBe(2);
    // Free exactly one slot.
    s = dismissToast(s, s.visible[0]!.id, T0);
    expect(s.visible.map((t) => t.msg)).toContain('queued-error');
    expect(s.visible.map((t) => t.msg)).not.toContain('queued-info');
  });

  it('keeps FIFO order within one severity', () => {
    let s = pushAll(emptyToasts(), [
      ['a', 'info'], ['b', 'info'], ['c', 'info'],
      ['first', 'warn'], ['second', 'warn'],
    ]);
    s = dismissToast(s, s.visible[0]!.id, T0);
    expect(s.visible.map((t) => t.msg)).toContain('first');
    expect(s.visible.map((t) => t.msg)).not.toContain('second');
  });
});

describe('dedupe', () => {
  it('counts a repeated visible message instead of stacking copies', () => {
    let s = pushToast(emptyToasts(), 'same', 'info', T0);
    s = pushToast(s, 'same', 'info', T0 + 10);
    s = pushToast(s, 'same', 'info', T0 + 20);
    expect(s.visible).toHaveLength(1);
    expect(s.visible[0]!.count).toBe(3);
  });

  it('restarts the clock of the toast it deduped onto', () => {
    let s = pushToast(emptyToasts(), 'same', 'info', T0);
    s = pushToast(s, 'same', 'info', T0 + 500);
    expect(s.visible[0]!.expiresAt).toBe(T0 + 500 + DURATION.info);
  });

  it('does not merge the same text at different severities', () => {
    let s = pushToast(emptyToasts(), 'x', 'info', T0);
    s = pushToast(s, 'x', 'error', T0);
    expect(s.visible).toHaveLength(2);
  });

  it('dedupes onto a QUEUED toast without promoting it', () => {
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info'], ['waiting', 'info']]);
    s = pushToast(s, 'waiting', 'info', T0 + 5);
    expect(overflowCount(s)).toBe(1);
    expect(s.queued[0]!.count).toBe(2);
  });
});

describe('lifetime', () => {
  it('keeps an error up longer than a success', () => {
    expect(DURATION.error).toBeGreaterThan(DURATION.success);
  });

  it('expires each severity on its own schedule', () => {
    let s = pushAll(emptyToasts(), [['ok', 'success'], ['bad', 'error']]);
    s = expireToasts(s, T0 + DURATION.success + 1);
    expect(s.visible.map((t) => t.msg)).toEqual(['bad']);
  });

  it('leaves unexpired toasts alone', () => {
    const s = pushAll(emptyToasts(), [['a', 'info']]);
    expect(expireToasts(s, T0 + 1).visible).toHaveLength(1);
  });
});

describe('dismiss and hold', () => {
  it('removes a toast by id', () => {
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info']]);
    s = dismissToast(s, s.visible[0]!.id, T0);
    expect(s.visible.map((t) => t.msg)).toEqual(['b']);
  });

  it('can dismiss something still waiting in the queue', () => {
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info'], ['d', 'info']]);
    const queuedId = s.queued[0]!.id;
    s = dismissToast(s, queuedId, T0);
    expect(overflowCount(s)).toBe(0);
    expect(s.visible).toHaveLength(3);
  });

  it('hold pushes the expiry out so a hovered toast survives its normal lifetime', () => {
    let s = pushAll(emptyToasts(), [['a', 'info']]);
    const id = s.visible[0]!.id;
    const late = T0 + DURATION.info - 1;
    s = holdToast(s, id, late);
    s = expireToasts(s, T0 + DURATION.info + 1);
    expect(s.visible).toHaveLength(1);
  });
});

describe('state is not mutated in place', () => {
  it('returns a new state and leaves the original untouched', () => {
    const a = pushAll(emptyToasts(), [['x', 'info']]);
    const b = pushToast(a, 'y', 'info', T0);
    expect(a.visible).toHaveLength(1);
    expect(b.visible).toHaveLength(2);
  });
});

describe('actionable toasts', () => {
  it('carries one action and an explicit lifetime', () => {
    const run = (): void => {};
    const s = pushToast(emptyToasts(), 'Closed "QMK-Flasher"', 'info', T0, { action: { label: 'Undo', run }, durationMs: 9000 });
    expect(s.visible[0]!.action).toEqual({ label: 'Undo', run });
    expect(s.visible[0]!.expiresAt).toBe(T0 + 9000);
  });

  // Two closes in a row must offer two Undos: dedupe would hand the second one the first
  // close's action, which restores the wrong workspace.
  it('never dedupes an actionable toast, even with identical text', () => {
    const mk = (n: number) => ({ label: 'Undo', run: () => { calls.push(n); } });
    const calls: number[] = [];
    let s = pushToast(emptyToasts(), 'Closed "scratch"', 'info', T0, { action: mk(1) });
    s = pushToast(s, 'Closed "scratch"', 'info', T0, { action: mk(2) });
    expect(s.visible).toHaveLength(2);
    expect(s.visible.every((t) => t.count === 1)).toBe(true);
    s.visible[0]!.action!.run();
    s.visible[1]!.action!.run();
    expect(calls).toEqual([1, 2]);
  });

  it('does not merge a plain message into an actionable one of the same text', () => {
    let s = pushToast(emptyToasts(), 'same', 'info', T0, { action: { label: 'Undo', run: () => {} } });
    s = pushToast(s, 'same', 'info', T0);
    expect(s.visible).toHaveLength(2);
  });

  it('keeps its own lifetime through a hold and a promotion', () => {
    const long = { durationMs: 9000, action: { label: 'Undo', run: () => {} } };
    // Fill every visible slot so the actionable toast has to wait for one.
    let s = pushAll(emptyToasts(), [['a', 'info'], ['b', 'info'], ['c', 'info']]);
    s = pushToast(s, 'Closed "x"', 'info', T0, long);
    expect(overflowCount(s)).toBe(1);
    const promotedAt = T0 + DURATION.info + 1;
    s = expireToasts(s, promotedAt);
    const item = s.visible.find((t) => t.action)!;
    expect(item.expiresAt).toBe(promotedAt + 9000); // NOT demoted to DURATION.info
    s = holdToast(s, item.id, promotedAt + 100);
    expect(s.visible.find((t) => t.action)!.expiresAt).toBe(promotedAt + 100 + 9000);
  });

  it(`leaves plain toasts on their severity's clock`, () => {
    const s = pushToast(emptyToasts(), 'plain', 'warn', T0);
    expect(s.visible[0]!.durationMs).toBe(DURATION.warn);
    expect(s.visible[0]!.action).toBeUndefined();
  });
});
