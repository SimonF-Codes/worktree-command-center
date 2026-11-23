import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendIsolationRecord, readIsolationLog, ISOLATION_LOG } from '../src/terminals/isolation-log';
import { decideIsolation, isolationRecord, type IsolationIntent, type IsolationContext } from '../src/core/isolation';
import { makeTempDir } from './temp-dir';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
const tmp = () => { const d = makeTempDir('iso-log-'); dirs.push(d); return d; };

const checkout = { id: 'c:/dev/app', path: 'C:/dev/app', primary: true };
const rec = (i: IsolationIntent, c: IsolationContext, outcome = {}) => isolationRecord('app', i, c, decideIsolation(i, c), outcome);
const ctx = (o: Partial<IsolationContext> = {}): IsolationContext => ({ now: 1, claims: [], policy: 'cheap-readonly', rungCeiling: 'write', ...o });

describe('isolation.jsonl', () => {
	it('appends one line per decision, in order, and never rewrites earlier ones', () => {
		const dir = path.join(tmp(), 'ws'); // not yet created — the first append makes it
		const a = rec({ taskClass: 'feature', writes: 'repo', checkout }, ctx(), { sessionId: 's-1', cwd: 'C:/dev/app/.claude-worktrees/wt-1' });
		const b = rec({ taskClass: 'investigate', writes: 'none', checkout }, ctx({ now: 2 }), { sessionId: 's-2', cwd: 'C:/dev/app' });
		const c = rec({ taskClass: 'small-fix', writes: 'repo', checkout }, ctx({ now: 3, rungCeiling: 'readonly', role: 'researcher' }));
		expect(appendIsolationRecord(dir, a)).toBe(true);
		const first = fs.readFileSync(path.join(dir, ISOLATION_LOG), 'utf8');
		appendIsolationRecord(dir, b); appendIsolationRecord(dir, c);
		const text = fs.readFileSync(path.join(dir, ISOLATION_LOG), 'utf8');
		expect(text.startsWith(first)).toBe(true);
		expect(text.trimEnd().split('\n')).toHaveLength(3);
		const back = readIsolationLog(dir);
		expect(back.map((r) => r.ok && r.mode)).toEqual(['worktree', 'shared-readonly', false]);
		expect(back[2]).toMatchObject({ ok: false, holder: 'researcher', path: 'C:/dev/app' });
	});
	it('counts worktree creation — the figure board.md undercounts', () => {
		const dir = tmp();
		for (const writes of ['repo', 'none', 'repo', 'outside'] as const) appendIsolationRecord(dir, rec({ taskClass: 'feature', writes, checkout }, ctx(), { sessionId: 's' }));
		expect(readIsolationLog(dir).filter((r) => r.ok && r.mode === 'worktree' && r.sessionId).length).toBe(2);
	});
	it('reading skips torn or foreign lines; a missing file is an empty log', () => {
		const dir = tmp();
		expect(readIsolationLog(dir)).toEqual([]);
		appendIsolationRecord(dir, rec({ taskClass: 'feature', writes: 'repo', checkout }, ctx()));
		fs.appendFileSync(path.join(dir, ISOLATION_LOG), '{"v":1,"ok":tr\nnot json\n{"v":2,"ok":true}\n');
		expect(readIsolationLog(dir)).toHaveLength(1);
	});
	it('a write failure is reported, not thrown — a spawn never fails on the measurement', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const file = path.join(tmp(), 'a-file');
		fs.writeFileSync(file, 'x');
		expect(appendIsolationRecord(path.join(file, 'under-a-file'), rec({ taskClass: 'feature', writes: 'repo', checkout }, ctx()))).toBe(false);
	});
});
