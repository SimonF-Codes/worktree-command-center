import { describe, it, expect, afterEach } from 'vitest';
import { runCommand } from '../src/command-runner';

const g = globalThis as { wcc?: unknown };

afterEach(() => { delete g.wcc; });

describe('runCommand', () => {
  it('delegates to the wcc bridge when one is present (renderer path)', async () => {
    const calls: Array<[string, string[], object | undefined]> = [];
    g.wcc = {
      runCommand: (c: string, a: string[], o?: object) => {
        calls.push([c, a, o]);
        return Promise.resolve({ stdout: 'bridged', stderr: '', code: 0, timedOut: false });
      },
    };
    const r = await runCommand('git', ['status'], { cwd: '/somewhere' });
    expect(r.stdout).toBe('bridged');
    expect(calls).toEqual([['git', ['status'], { cwd: '/somewhere' }]]);
  });

  it('captures stdout/stderr and the exit code from a real process', async () => {
    const r = await runCommand(process.execPath, [
      '-e',
      'process.stdout.write("out");process.stderr.write("err")',
    ]);
    expect(r.stdout).toBe('out');
    expect(r.stderr).toBe('err');
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('reports a non-zero exit code without rejecting', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('resolves with an error (never rejects) when the binary is missing', async () => {
    const r = await runCommand('wcc-no-such-binary-xyz', []);
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});
