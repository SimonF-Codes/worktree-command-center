import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldTransfers, transferSubject, transfersFor, SUBJECT_MAX, type RequestFile } from '../src/core/transfers';
import { readFolderCached, type FolderIo } from '../src/terminals/append-log-cache';
import { makeTempDir } from './temp-dir';

// Invisible characters are built from code points, never typed into this file, so that what the
// test checks is what the reader sees.
const cp = (...n: number[]) => String.fromCodePoint(...n);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const hex = (n: number) => `U+${n.toString(16).toUpperCase().padStart(4, '0')}`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('transferSubject — one safe line', () => {
	it('takes the first non-empty line, collapses whitespace, and lets a tab separate words', () => {
		expect(transferSubject('\n\n   \n  Rebase   onto\tmain  \nsecond line')).toBe('Rebase onto main');
		expect(transferSubject('a\r\nb')).toBe('a');
		expect(transferSubject(`a${cp(0x2028)}b`)).toBe('a');
		expect(transferSubject(`a${cp(0x85)}b`)).toBe('a');
	});

	it('cuts to 120 code points, ellipsis included, without splitting a surrogate pair', () => {
		const long = 'x'.repeat(200);
		expect(Array.from(transferSubject(long))).toHaveLength(SUBJECT_MAX);
		expect(transferSubject(long).endsWith('…')).toBe(true);
		expect(transferSubject('y'.repeat(120))).toBe('y'.repeat(120));
		const emoji = cp(0x1F600).repeat(130);
		const cut = Array.from(transferSubject(emoji));
		expect(cut).toHaveLength(SUBJECT_MAX);
		expect(cut.slice(0, -1).every((c) => c === cp(0x1F600))).toBe(true);
	});

	it('keeps ordinary non-ASCII text, and gives "" for anything that is not a string', () => {
		expect(transferSubject('café — ünïcode 日本語 ✓')).toBe('café — ünïcode 日本語 ✓');
		expect(transferSubject(undefined)).toBe('');
		expect(transferSubject(42)).toBe('');
		expect(transferSubject({ toString: () => 'x' })).toBe('');
	});

	it('a line made only of removed characters is empty, so the next line is the subject', () => {
		expect(transferSubject(`${cp(0x202E, 0x200B, 0xE0041)}\nreal`)).toBe('real');
	});

	const groups: Array<[string, number[]]> = [
		['the direction embeddings and overrides U+202A–U+202E', range(0x202A, 0x202E)],
		['the isolates U+2066–U+2069', range(0x2066, 0x2069)],
		['the marks U+200E, U+200F, U+061C', [0x200E, 0x200F, 0x061C]],
		['the zero-width characters U+200B–U+200D', range(0x200B, 0x200D)],
		['the word joiner U+2060', [0x2060]],
		['the tag block U+E0000–U+E007F', range(0xE0000, 0xE007F)],
		['the C0 controls (and DEL)', [...range(0x00, 0x08), ...range(0x0E, 0x1F), 0x7F]],
		['the C1 controls', [...range(0x80, 0x84), ...range(0x86, 0x9F)]],
	];
	for (const [name, points] of groups) {
		it(`removes ${name}`, () => {
			for (const p of points) {
				expect(transferSubject(`ab${cp(p)}cd`), hex(p)).toBe('abcd');
				expect(transferSubject(`${cp(p)}lead`), hex(p)).toBe('lead');
			}
		});
	}

	it('a direction override cannot reorder what is shown', () => {
		// Left in, the override would display "txt.exe" reversed, as "exe.txt". Removed, it reads as stored.
		expect(transferSubject(`run ${cp(0x202E)}txt.exe${cp(0x202C)} now`)).toBe('run txt.exe now');
	});
});

// ---- the fold

const OVERSEER = 'a9454853-8df6-4e9e-a23b-19f920cfb7b1';
const req = (ts: number, o: Record<string, unknown>, id = 'x'): RequestFile => ({ file: `${ts}-${id}.json`, text: JSON.stringify({ ts, ...o }) });
const overseer = { kind: 'god', sessionId: OVERSEER };
const child = (name: string, sessionId: string, parent?: string) => ({ kind: 'terminal', name, sessionId, ...(parent ? { parentSessionId: parent } : {}) });

describe('foldTransfers — the unmatched path: history whose sessions have left the file', () => {
	it('a spawn whose name matches no session under its sender is listed as unmatched and not drawn', () => {
		const f = foldTransfers({ requests: [req(1_000, { kind: 'spawn', repo: 'r', task: 'do it', name: 'Sidebar', from: OVERSEER })], sessions: [overseer] });
		expect(f.transfers).toHaveLength(1);
		const t = f.transfers[0]!;
		expect(t.match).toEqual({ state: 'unmatched', reason: 'no session under the sender is named "Sidebar" now' });
		expect(t.drawn).toBe(false);
		expect(t.delivery).toBe('sent');
		expect(t.from).toEqual({ sessionId: OVERSEER, name: null, kind: 'god' });
		expect(f.counts.byState.unmatched).toBe(1);
	});

	it('a session with the right name but no parent is NOT taken as the child — that would be a guess', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'spawn', repo: 'r', task: 't', name: 'Sidebar', from: OVERSEER })], sessions: [overseer, child('Sidebar', 's1')] });
		expect(f.transfers[0]!.match.state).toBe('unmatched');
	});

	it('two sessions answering to one name are reported as two, and nothing is drawn', () => {
		const sessions = [overseer, child('Lanes', 's1', OVERSEER), child('lanes', 's2', OVERSEER)];
		const spawn = foldTransfers({ requests: [req(1, { kind: 'spawn', repo: 'r', task: 't', name: 'LANES', from: OVERSEER })], sessions });
		expect(spawn.transfers[0]!.match).toMatchObject({ state: 'unmatched' });
		expect((spawn.transfers[0]!.match as { reason: string }).reason).toMatch(/matches 2 sessions under the sender .*not guessed/);
		const tell = foldTransfers({ requests: [req(1, { kind: 'tell', target: 'LANES', message: 'm', from: OVERSEER })], sessions });
		expect((tell.transfers[0]!.match as { reason: string }).reason).toMatch(/matches 2 sessions on the floor/);
		expect(tell.transfers[0]!.drawn).toBe(false);
	});

	it('a tell to a name no longer on the floor is unmatched', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'tell', target: 'Gone', message: 'hi', from: OVERSEER })], sessions: [overseer] });
		expect(f.transfers[0]!.match).toEqual({ state: 'unmatched', reason: 'no session on the floor is named "Gone" now' });
	});

	it('a spawn that named no child is unmatched: the app chose the name and nothing joins them', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'spawn', repo: 'r', task: 't', from: OVERSEER })], sessions: [overseer, child('Worker 3', 's1', OVERSEER)] });
		expect((f.transfers[0]!.match as { reason: string }).reason).toMatch(/named no child/);
	});

	it('a request with no sessions file at all is unmatched, not an error', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'tell', target: 'A', message: 'm', from: OVERSEER })], sessions: [] });
		expect(f.transfers[0]!.match.state).toBe('unmatched');
		expect(f.transfers[0]!.from).toEqual({ sessionId: OVERSEER, name: null, kind: null });
	});
});

describe('foldTransfers — what it draws, and what it only lists', () => {
	const sessions = [overseer, child('P5a transfers', 'kid', OVERSEER), child('Toolbar one', 'solo'), { kind: 'journal', name: 'Journal 1' }];

	it('a request with no `from` is plain lineage — never a transfer, even when its name would match', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'spawn', repo: 'r', task: 't', name: 'P5a transfers' }), req(2, { kind: 'tell', target: 'P5a transfers', message: 'm' })], sessions });
		expect(f.transfers.map((t) => t.match.state)).toEqual(['unattributed', 'unattributed']);
		expect(f.transfers.every((t) => !t.drawn && t.from === null)).toBe(true);
		expect(f.counts.byState.unattributed).toBe(2);
	});

	it('a spawn joins its child through parentSessionId and name, carrying the brief\'s role and isolation', () => {
		const f = foldTransfers({ requests: [req(5, { kind: 'spawn', repo: 'wcc', task: 'Line one\nline two', name: 'P5a transfers', role: 'worker-terminal', isolation: 'worktree', taskClass: 'code', from: OVERSEER })], sessions });
		const t = f.transfers[0]!;
		expect(t.match).toEqual({ state: 'edge', to: { sessionId: 'kid', name: 'P5a transfers', kind: 'terminal' } });
		expect(t.drawn).toBe(true);
		expect(t.subject).toBe('Line one');
		expect(t.length).toBe('Line one\nline two'.length);
		expect(t.brief).toEqual({ repo: 'wcc', role: 'worker-terminal', isolation: 'worktree', taskClass: 'code' });
	});

	it('a tell or watch to the sender\'s child is on its edge; to anyone else it is sent but on no edge', () => {
		const f = foldTransfers({ requests: [
			req(1, { kind: 'tell', target: 'p5a TRANSFERS', message: 'rebase', from: OVERSEER }, 'a'),
			req(2, { kind: 'watch', target: 'P5a transfers', note: 'idle: review', from: OVERSEER }, 'b'),
			req(3, { kind: 'tell', target: 'Toolbar one', message: 'hello', from: OVERSEER }, 'c'),
		], sessions });
		expect(f.transfers.map((t) => [t.kind, t.match.state, t.drawn])).toEqual([['tell', 'edge', true], ['watch', 'edge', true], ['tell', 'off-edge', false]]);
		expect(f.transfers[1]!.subject).toBe('idle: review');
	});

	it('a close is folded and listed but never drawn, even when its target is still on the floor', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'close', target: 'P5a transfers', from: OVERSEER })], sessions });
		expect(f.transfers[0]).toMatchObject({ kind: 'close', match: { state: 'closed' }, drawn: false, subject: null, length: null });
		expect(f.counts.byKind.close).toBe(1);
	});

	it('a journal and an overseer are never a target', () => {
		const f = foldTransfers({ requests: [req(1, { kind: 'tell', target: 'Journal 1', message: 'm', from: OVERSEER })], sessions });
		expect(f.transfers[0]!.match.state).toBe('unmatched');
	});

	it('a tell older than the spawn of the session that now has the name went to an earlier session', () => {
		const f = foldTransfers({ requests: [
			req(10, { kind: 'tell', target: 'P5a transfers', message: 'old', from: OVERSEER }, 'a'),
			req(20, { kind: 'spawn', repo: 'r', task: 't', name: 'P5a transfers', from: OVERSEER }, 'b'),
			req(30, { kind: 'tell', target: 'P5a transfers', message: 'new', from: OVERSEER }, 'c'),
		], sessions });
		expect(f.transfers.map((t) => t.match.state)).toEqual(['unmatched', 'edge', 'edge']);
		expect((f.transfers[0]!.match as { reason: string }).reason).toMatch(/sent before P5a transfers \(kid\) was spawned/);
	});

	it('of two spawns of one name by one sender, only the later is the session on the floor', () => {
		const f = foldTransfers({ requests: [
			req(10, { kind: 'spawn', repo: 'r', task: 'first', name: 'P5a transfers', from: OVERSEER }, 'a'),
			req(20, { kind: 'spawn', repo: 'r', task: 'second', name: 'P5a transfers', from: OVERSEER }, 'b'),
		], sessions });
		expect(f.transfers.map((t) => t.match.state)).toEqual(['unmatched', 'edge']);
		expect(f.transfers.filter((t) => t.drawn)).toHaveLength(1);
	});

	it('orders oldest first; a missing ts falls back to the file name, then to null', () => {
		const f = foldTransfers({ requests: [
			{ file: '3000000000000-b.json', text: JSON.stringify({ kind: 'tell', target: 'x', message: 'm' }) },
			{ file: 'odd.json', text: JSON.stringify({ kind: 'tell', target: 'x', message: 'm' }) },
			req(2000000000000, { kind: 'tell', target: 'x', message: 'm' }, 'a'),
		], sessions: [] });
		expect(f.transfers.map((t) => t.ts)).toEqual([null, 2000000000000, 3000000000000]);
	});

	it('skips what is not a request of a folded kind, and says why', () => {
		const f = foldTransfers({ requests: [
			{ file: '1-a.json', text: '{nope' },
			{ file: '2-b.json', text: '[1]' },
			{ file: '3-c.json', text: JSON.stringify({ kind: 'rename', target: 'a', name: 'b' }) },
		], sessions: [] });
		expect(f.transfers).toEqual([]);
		expect(f.skipped).toEqual([
			{ file: '1-a.json', reason: 'invalid JSON' },
			{ file: '2-b.json', reason: 'not a JSON object' },
			{ file: '3-c.json', reason: 'kind rename is not a transfer' },
		]);
		expect(f.counts.requests).toBe(3);
	});

	it('cleans everything it reads, not only the message: names, targets, ids and the brief', () => {
		const rlo = cp(0x202E), zw = cp(0x200B), tag = cp(0xE0041);
		const f = foldTransfers({ requests: [
			{ file: `5-a${rlo}.json`, text: JSON.stringify({ ts: 5, kind: 'spawn', repo: `r${zw}`, task: `go${tag}\nmore`, name: `Kid${rlo}`, role: `wor${zw}ker`, from: OVERSEER }) },
		], sessions: [overseer, child(`Kid${rlo}`, `kid${zw}`, OVERSEER)] });
		const t = f.transfers[0]!;
		expect(t.id).toBe('5-a');
		expect(t.subject).toBe('go');
		expect(t.toName).toBe('Kid');
		expect(t.brief).toMatchObject({ repo: 'r', role: 'worker' });
		expect(t.match).toEqual({ state: 'edge', to: { sessionId: 'kid', name: 'Kid', kind: 'terminal' } });
		const out = JSON.stringify(f);
		for (const c of [rlo, zw, tag]) expect(out.includes(c)).toBe(false);
	});

	it('transfersFor picks what one session sent or received', () => {
		const f = foldTransfers({ requests: [
			req(1, { kind: 'spawn', repo: 'r', task: 't', name: 'P5a transfers', from: OVERSEER }, 'a'),
			req(2, { kind: 'tell', target: 'Toolbar one', message: 'm', from: 'someone-else' }, 'b'),
			req(3, { kind: 'tell', target: 'Gone', message: 'm', from: OVERSEER }, 'c'),
		], sessions });
		expect(transfersFor(f, 'kid').map((t) => t.id)).toEqual(['1-a']);
		expect(transfersFor(f, OVERSEER).map((t) => t.id)).toEqual(['1-a', '3-c']);
		expect(transfersFor(f, 'solo').map((t) => t.id)).toEqual(['2-b']);
	});
});

// ---- the folder cache

describe('readFolderCached — read each claimed request once', () => {
	function fakeFolder() {
		const files = new Map<string, string>([['1-a.json', 'A'], ['2-b.json', 'B'], ['notes.txt', 'ignored']]);
		let mtime = 100;
		const calls = { mtime: 0, list: 0, read: [] as string[] };
		const io: FolderIo = {
			mtimeMs: () => { calls.mtime++; return mtime; },
			list: () => { calls.list++; return [...files.keys()]; },
			read: (f) => { const n = path.basename(f); calls.read.push(n); return files.get(n) ?? null; },
		};
		return { files, io, calls, touch: () => { mtime++; } };
	}

	it('a second read of an unchanged folder opens no file and returns the same value', () => {
		const dir = path.join('virtual', 'one');
		const f = fakeFolder();
		const first = readFolderCached(dir, undefined, f.io);
		expect(first).toEqual([{ file: '1-a.json', text: 'A' }, { file: '2-b.json', text: 'B' }]);
		expect(f.calls.read).toEqual(['1-a.json', '2-b.json']);
		const second = readFolderCached(dir, undefined, f.io);
		expect(second).toBe(first);
		expect(f.calls.read).toHaveLength(2); // nothing new opened
	});

	it('a file renamed in reads only that file; one that left is dropped without a read', () => {
		const dir = path.join('virtual', 'two');
		const f = fakeFolder();
		readFolderCached(dir, undefined, f.io);
		f.files.set('3-c.json', 'C'); f.touch();
		expect(readFolderCached(dir, undefined, f.io).map((x) => x.file)).toEqual(['1-a.json', '2-b.json', '3-c.json']);
		expect(f.calls.read).toEqual(['1-a.json', '2-b.json', '3-c.json']);
		f.files.delete('1-a.json'); f.touch();
		expect(readFolderCached(dir, undefined, f.io).map((x) => x.file)).toEqual(['2-b.json', '3-c.json']);
		expect(f.calls.read).toHaveLength(3);
	});

	it('the entry count is a key of its own: a change the mtime missed is still seen', () => {
		const dir = path.join('virtual', 'three');
		const f = fakeFolder();
		readFolderCached(dir, undefined, f.io);
		f.files.set('3-c.json', 'C'); // mtime NOT moved
		expect(readFolderCached(dir, undefined, f.io)).toHaveLength(3);
	});

	it('a file that could not be read is not cached as absent: the next call tries it again', () => {
		const dir = path.join('virtual', 'four');
		const f = fakeFolder();
		const read = f.io.read;
		let fail = true;
		f.io.read = (p) => (fail && p.endsWith('2-b.json') ? null : read(p));
		expect(readFolderCached(dir, undefined, f.io).map((x) => x.file)).toEqual(['1-a.json']);
		fail = false;
		expect(readFolderCached(dir, undefined, f.io).map((x) => x.file)).toEqual(['1-a.json', '2-b.json']);
		expect(f.calls.read.filter((n) => n === '1-a.json')).toHaveLength(1);
	});

	it('a missing folder reads as empty', () => {
		const io: FolderIo = { mtimeMs: () => null, list: () => null, read: () => null };
		expect(readFolderCached(path.join('virtual', 'none'), undefined, io)).toEqual([]);
	});

	it('on the real file system, a request renamed into the folder is picked up', () => {
		const root = makeTempDir('transfers-'); dirs.push(root);
		const done = path.join(root, '.done');
		fs.mkdirSync(done);
		fs.writeFileSync(path.join(done, '1-a.json'), '{"kind":"tell"}');
		expect(readFolderCached(done)).toHaveLength(1);
		fs.writeFileSync(path.join(root, '2-b.json'), '{"kind":"close"}');
		fs.renameSync(path.join(root, '2-b.json'), path.join(done, '2-b.json'));
		expect(readFolderCached(done).map((x) => x.file)).toEqual(['1-a.json', '2-b.json']);
	});
});
