import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldItems, normalise, RESULT_MAX, type ChatItem } from '../src/core/transcript';
// The committed scrubber: a plain .mjs script, so the next capture needs no build.
import { makeScrubber, findLeaks, stringsOf, filler, SAFE_KEYS, ID_KEYS, KEPT_TAGS, EPOCH } from './fixtures/transcripts/scrub.mjs';

const FIX = path.join(__dirname, 'fixtures', 'transcripts');
const read = (name: string): string[] => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.trim());
const one = (o: unknown, ref?: string | number): ChatItem[] => normalise(JSON.stringify(o), ref);
const base = { uuid: 'u-1', parentUuid: null, timestamp: '2030-01-01T00:00:01.000Z', sessionId: 's', cwd: '/w', gitBranch: 'main', isSidechain: false, version: '2.1.332' };
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...extra });
const asst = (block: unknown, extra: Record<string, unknown> = {}) => ({ ...base, type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [block] }, ...extra });
const T = Date.parse(base.timestamp);

describe('normalise — the human prompt, told from an injected user line', () => {
	it('origin.kind "human" is a prompt; a list of blocks gives its text, images marked', () => {
		expect(one(user('fix the bug', { origin: { kind: 'human' }, promptSource: 'typed' }))).toEqual([{ kind: 'prompt', id: 'u-1', ts: T, text: 'fix the bug' }]);
		expect(one(user([{ type: 'image', source: {} }, { type: 'text', text: 'this' }], { origin: { kind: 'human' } }))).toEqual([{ kind: 'prompt', id: 'u-1', ts: T, text: '[image]\nthis' }]);
	});

	it('isMeta and the compact summary are skipped by name, whatever else they carry', () => {
		expect(one(user('<system-reminder>x</system-reminder>', { isMeta: true }))).toEqual([{ kind: 'skipped', lineType: 'user/meta' }]);
		expect(one(user('This session is being continued…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }))).toEqual([{ kind: 'skipped', lineType: 'user/compact-summary' }]);
	});

	it('another origin is a notice: a background task by its summary, a peer by name', () => {
		expect(one(user('<task-notification><task-id>b1</task-id><status>completed</status><summary>Build passed</summary></task-notification>', { origin: { kind: 'task-notification' } })))
			.toEqual([{ kind: 'notice', id: 'u-1', ts: T, text: 'Background task: Build passed' }]);
		expect(one(user('hello', { origin: { kind: 'peer' } }))[0]).toMatchObject({ kind: 'notice', text: 'peer: hello' });
	});

	it('with no origin, the leading tag decides; plain text (sdk prompts, a sub-agent brief) is a prompt', () => {
		const k = (c: string) => one(user(c))[0];
		expect(k('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toMatchObject({ kind: 'notice', text: '/clear' });
		expect(k('<command-name>/model</command-name><command-args>opus</command-args>')).toMatchObject({ kind: 'notice', text: '/model opus' });
		expect(k('<bash-input>git status</bash-input>')).toMatchObject({ kind: 'prompt', text: '! git status' });
		expect(k('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>')).toMatchObject({ kind: 'notice', text: 'clean' });
		expect(k('<local-command-stdout>Set model to opus</local-command-stdout>')).toMatchObject({ kind: 'notice', text: 'Set model to opus' });
		expect(k('[Request interrupted by user]')).toMatchObject({ kind: 'notice', text: 'Request interrupted by user' });
		expect(k('<something-new>x</something-new>')).toMatchObject({ kind: 'notice', text: 'x' });
		expect(k('summarise the repo')).toMatchObject({ kind: 'prompt', text: 'summarise the repo' });
	});
});

describe('normalise — tools, replies and thinking', () => {
	it('a tool_use is a call with no result yet; its tool_result is a separate line, carrying no name', () => {
		expect(one(asst({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' }, caller: { type: 'direct' } })))
			.toEqual([{ kind: 'tool', id: 'toolu_1', ts: T, name: 'Bash', input: { command: 'ls' }, status: 'no-result-yet' }]);
		expect(one(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }], { toolUseResult: {} })))
			.toEqual([{ kind: 'tool', id: 'toolu_1', ts: T, name: '', input: undefined, status: 'done', result: { text: 'a\nb', truncated: false } }]);
		const err = one(user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'denied' }, { type: 'image', source: {} }, { type: 'tool_reference', tool_name: 'Read' }] }]))[0];
		expect(err).toMatchObject({ status: 'error', result: { text: 'denied\n[image]\n[tool: Read]', truncated: false } });
	});

	it('a long result is cut, and says so', () => {
		const r = one(user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(RESULT_MAX + 5) }]))[0] as Extract<ChatItem, { kind: 'tool' }>;
		expect(r.result).toEqual({ text: 'x'.repeat(RESULT_MAX), truncated: true });
	});

	it('text is a reply; thinking is shown only when its text is on disk; an unknown block is skipped by type', () => {
		expect(one(asst({ type: 'text', text: '**done**' }))).toEqual([{ kind: 'reply', id: 'u-1', ts: T, markdown: '**done**' }]);
		expect(one(asst({ type: 'thinking', thinking: 'hmm', signature: 's' }))).toEqual([{ kind: 'thinking', id: 'u-1', ts: T, text: 'hmm' }]);
		expect(one(asst({ type: 'thinking', thinking: '', signature: 's' }))).toEqual([{ kind: 'skipped', lineType: 'assistant/thinking-not-on-disk' }]);
		expect(one(asst({ type: 'redacted_thinking', data: 'x' }))).toEqual([{ kind: 'skipped', lineType: 'assistant/redacted_thinking' }]);
	});

	it('two blocks on one line (never seen, but not assumed away) get distinct ids', () => {
		const o = { ...asst({}), message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } };
		expect(one(o).map((i) => (i as { id: string }).id)).toEqual(['u-1:0', 'u-1:1']);
	});

	it('an API error the CLI wrote as a reply is a notice', () => {
		expect(one(asst({ type: 'text', text: 'API Error: 529' }, { isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529' }] } })))
			.toEqual([{ kind: 'notice', id: 'u-1', ts: T, text: 'API Error: 529' }]);
	});
});

describe('normalise — system lines, attachments, and the session lifecycle', () => {
	it('a compaction is a notice; turn bookkeeping is skipped by subtype', () => {
		expect(one({ ...base, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual' } }))
			.toEqual([{ kind: 'notice', id: 'u-1', ts: T, text: 'Conversation compacted (manual)' }]);
		expect(one({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 5 })).toEqual([{ kind: 'skipped', lineType: 'system/turn_duration' }]);
		expect(one({ ...base, type: 'system', subtype: 'local_command', content: '<local-command-stdout>ok</local-command-stdout>' })[0]).toMatchObject({ kind: 'notice', text: 'ok' });
		expect(one({ ...base, type: 'system', subtype: 'informational', content: '' })).toEqual([{ kind: 'skipped', lineType: 'system/informational' }]);
	});

	it('a prompt typed while a turn ran exists only as a queued_command attachment — and is a prompt, at the time it was typed', () => {
		const q = (a: Record<string, unknown>) => one({ ...base, type: 'attachment', attachment: { type: 'queued_command', timestamp: '2030-01-01T00:00:00.500Z', ...a } })[0];
		expect(q({ commandMode: 'prompt', prompt: 'also do X', origin: { kind: 'human' } })).toEqual({ kind: 'prompt', id: 'u-1', ts: T - 500, text: 'also do X' });
		expect(q({ commandMode: 'task-notification', prompt: '<task-notification><summary>done</summary></task-notification>' })).toMatchObject({ kind: 'notice', text: 'Background task: done' });
		expect(q({ commandMode: 'prompt', prompt: 'x', origin: { kind: 'peer' }, isMeta: true })).toEqual({ kind: 'skipped', lineType: 'attachment/queued_command-meta' });
		expect(one({ ...base, type: 'attachment', attachment: { type: 'total_tokens_reminder' } })).toEqual([{ kind: 'skipped', lineType: 'attachment/total_tokens_reminder' }]);
	});

	it('a resume into the same file is a notice; lines with no uuid take their id from the ref', () => {
		expect(one({ type: 'derived-from', v: 1, sessionId: 's', sessions: [{ type: 'claude_code_session', id: 's', via: 'resume' }] }, 812))
			.toEqual([{ kind: 'notice', id: 'derived-from@812', ts: 0, text: 'Session resumed' }]);
		expect(one({ type: 'derived-from', v: 1, sessionId: 's', sessions: [{ type: 'claude_code_session', id: 's', via: 'compact' }] })).toEqual([{ kind: 'skipped', lineType: 'derived-from/compact' }]);
		expect(one({ type: 'continued-in', sessionId: 's', continuedInSessionId: 'n' }, 9)[0]).toMatchObject({ kind: 'notice', id: 'continued-in@9', text: 'Continued in session n' });
	});

	it('never throws: not JSON, not an object, no type, an unknown type', () => {
		expect(normalise('{"type":"user"')).toEqual([{ kind: 'skipped', lineType: '(unparseable)' }]);
		expect(normalise('[1]')).toEqual([{ kind: 'skipped', lineType: '(not an object)' }]);
		expect(normalise('{}')).toEqual([{ kind: 'skipped', lineType: '(no type)' }]);
		expect(normalise('{"type":"permission-mode","permissionMode":"plan"}')).toEqual([{ kind: 'skipped', lineType: 'permission-mode' }]);
		expect(normalise('{"type":"user"}')).toEqual([{ kind: 'prompt', id: 'user@', ts: 0, text: '' }]);
	});
});

describe('foldItems', () => {
	it('merges a result into its call, keeps an orphan result, fills missing times, counts skips', () => {
		const call: ChatItem = { kind: 'tool', id: 't1', ts: 10, name: 'Bash', input: { command: 'ls' }, status: 'no-result-yet' };
		const res: ChatItem = { kind: 'tool', id: 't1', ts: 20, name: '', input: undefined, status: 'error', result: { text: 'no', truncated: false } };
		const orphan: ChatItem = { kind: 'tool', id: 't0', ts: 5, name: '', input: undefined, status: 'done', result: { text: 'old', truncated: false } };
		const f = foldItems([orphan, call, { kind: 'skipped', lineType: 'mode' }, { kind: 'notice', id: 'n', ts: 0, text: 'Session resumed' }, res, { kind: 'skipped', lineType: 'mode' }]);
		expect(f.items).toEqual([orphan, { ...call, status: 'error', result: { text: 'no', truncated: false } }, { kind: 'notice', id: 'n', ts: 10, text: 'Session resumed' }]);
		expect(f.skipped).toEqual({ mode: 2 });
		expect(call.status).toBe('no-result-yet'); // inputs are not modified
	});
});

// The scrubbed captures. Each pins what the conversation reads as, item by item: a change in the
// format that changes what is drawn fails here first.
const shape = (name: string) => {
	const lines = read(name);
	const f = foldItems(lines.flatMap((l, i) => normalise(l, i)));
	return { lines, f, seq: f.items.map((i) => (i.kind === 'tool' ? `tool:${i.name || '?'}:${i.status}` : i.kind)).join(' ') };
};

describe('the fixtures, three releases apart: 2.1.220, 2.1.296, 2.1.332', () => {
	for (const v of ['2.1.220', '2.1.296', '2.1.332']) {
		it(`${v}: every line parses, every user and assistant line is accounted for, and pairing leaves no orphan`, () => {
			const { lines, f } = shape(`v${v}.jsonl`);
			const objs = lines.map((l) => JSON.parse(l) as { type: string; version?: string });
			expect(objs.filter((o) => o.version).every((o) => o.version === v)).toBe(true);
			expect(f.skipped['(unparseable)']).toBeUndefined();
			for (const l of lines) expect(normalise(l).length).toBeGreaterThan(0);
			expect(f.items.filter((i) => i.kind === 'tool' && !i.name)).toEqual([]);
			for (const k of ['prompt', 'reply', 'tool']) expect(f.items.some((i) => i.kind === k)).toBe(true);
		});
	}

	it('the item sequence each release draws', () => {
		expect(shape('v2.1.220.jsonl').seq).toBe('prompt reply tool:Bash:done tool:Bash:done tool:Bash:error tool:Bash:done tool:Bash:done tool:Bash:done reply tool:Read:done reply tool:AskUserQuestion:error prompt reply tool:Bash:done tool:Bash:done prompt tool:Bash:no-result-yet');
		expect(shape('v2.1.296.jsonl').seq).toBe('prompt tool:Bash:done tool:Bash:done reply tool:Bash:done reply tool:Write:done reply');
		expect(shape('v2.1.332.jsonl').seq).toBe('prompt tool:Bash:done reply tool:Edit:done prompt thinking tool:Bash:done thinking tool:Bash:done reply tool:Read:done');
	});

	it('the 2.1.220 capture holds a prompt typed mid-turn, which is an attachment and not a user line', () => {
		const lines = read('v2.1.220.jsonl').map((l) => JSON.parse(l) as { type: string; attachment?: { type: string } });
		const queued = lines.filter((o) => o.type === 'attachment' && o.attachment?.type === 'queued_command');
		expect(queued.length).toBeGreaterThan(0);
		expect(queued.flatMap((o) => normalise(JSON.stringify(o))).some((i) => i.kind === 'prompt')).toBe(true);
	});
});

describe('the four cases the design listed as unobserved', () => {
	it('compaction: a boundary notice in the same file; the summary line is skipped, not drawn as a prompt', () => {
		const { f, seq } = shape('compaction.jsonl');
		expect(seq).toBe('reply notice reply notice notice');
		expect(f.items.map((i) => (i.kind === 'notice' ? i.text : '')).filter(Boolean)[1]).toBe('Conversation compacted (auto)');
		expect(f.skipped['user/compact-summary']).toBe(1);
	});

	it('/clear: a new file whose first conversation line is the /clear command itself', () => {
		const { lines, f } = shape('clear.jsonl');
		expect(f.items[0]).toMatchObject({ kind: 'notice', text: '/clear' });
		expect(f.items[1]!.kind).toBe('prompt');
		const firstUser = lines.map((l) => JSON.parse(l) as { type: string; parentUuid?: unknown }).find((o) => o.type === 'user');
		expect(firstUser!.parentUuid).toBeNull();
	});

	it('--continue: the same file and session id, marked by a derived-from line, the parent chain unbroken', () => {
		const { lines, f } = shape('continue.jsonl');
		const objs = lines.map((l) => JSON.parse(l) as { type: string; sessionId?: string; parentUuid?: string | null });
		expect(new Set(objs.map((o) => o.sessionId).filter(Boolean)).size).toBe(1);
		expect(f.items[0]).toMatchObject({ kind: 'notice', text: 'Session resumed' });
		const prompt = objs.find((o) => o.type === 'user' && (o as { origin?: unknown }).origin);
		expect(typeof prompt!.parentUuid).toBe('string'); // it links back to the turn before the resume
	});

	it('a sub-agent: its own file, every conversation line a sidechain; it opens with its brief; the parent sees one Agent call', () => {
		const { lines, f } = shape('subagent.jsonl');
		const conv = lines.map((l) => JSON.parse(l) as { type: string; isSidechain?: boolean; agentId?: string }).filter((o) => ['user', 'assistant'].includes(o.type));
		expect(conv.every((o) => o.isSidechain === true && typeof o.agentId === 'string')).toBe(true);
		expect(new Set(conv.map((o) => o.agentId)).size).toBe(1);
		expect(f.items[0]!.kind).toBe('prompt');
		expect(shape('subagent-parent.jsonl').seq).toBe('tool:Agent:done tool:Bash:done tool:Bash:no-result-yet');
	});
});

describe('the scrubber: real structure, no real content', () => {
	const FILLER_ONLY = /^[a-z\s#*`>|-]*$/;
	const TAGS = new RegExp(`</?(?:${(KEPT_TAGS as string[]).join('|')})>`, 'g');
	/** Every string in a scrubbed line is one the scrubber is allowed to emit. */
	function check(v: unknown, key: string, parent: Record<string, unknown> | null, bad: string[]): void {
		if (typeof v === 'string') {
			const ok = (ID_KEYS as Set<string>).has(key) ? /^(?:[a-z]+_|agent-)?[0-9a-f-]*$/.test(v)
				: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) || (key === 'cwd' && /^\/work\/project-\d+$/.test(v)) || (key === 'gitBranch' && /^(main|master|HEAD|branch-\d+)$/.test(v))
				|| ((key === 'name' && parent?.type === 'tool_use') || key === 'tool_name' ? /^([A-Z][A-Za-z]+|mcp__server__tool)$/.test(v) || FILLER_ONLY.test(v) : false)
				|| ((SAFE_KEYS as Set<string>).has(key) && /^[A-Za-z0-9_.<>-]{0,64}$/.test(v))
				|| /^\[Request interrupted by user( for tool use)?\]$/.test(v)
				|| FILLER_ONLY.test(v.replace(/<command-(name|message)>\/?[a-z][a-z-]*<\/command-(name|message)>/g, '').replace(TAGS, ''));
			if (!ok) bad.push(`${key}=${v.slice(0, 40)}`);
		} else if (Array.isArray(v)) for (const x of v) check(x, key, parent, bad);
		else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) check(x, k, v as Record<string, unknown>, bad);
	}

	for (const name of fs.readdirSync(FIX).filter((n) => n.endsWith('.jsonl'))) {
		it(`${name}: every string is an id, an enum, a time, or filler — and nothing looks like a path or an address`, () => {
			const text = fs.readFileSync(path.join(FIX, name), 'utf8');
			expect(findLeaks(text)).toEqual([]);
			const bad: string[] = [];
			for (const l of read(name)) check(JSON.parse(l), '', null, bad);
			expect(bad).toEqual([]);
		});
	}

	it('removes content and keeps structure: ids consistent, times shifted with gaps kept, paths and keys replaced', () => {
		const s = makeScrubber('test-salt');
		const a = s.line({ type: 'user', uuid: 'aaaaaaaa-1111-2222-3333-444444444444', timestamp: '2026-11-27T10:00:00.000Z', cwd: 'C:\\Users\\someone\\repo', gitBranch: 'wt/secret-feature',
			message: { role: 'user', content: 'mail me at someone@example.com about C:\\Users\\someone\\x' }, origin: { kind: 'human' } });
		const b = s.line({ type: 'assistant', uuid: 'bbbbbbbb-1111-2222-3333-444444444444', parentUuid: 'aaaaaaaa-1111-2222-3333-444444444444', timestamp: '2026-11-27T10:00:05.000Z', cwd: 'C:\\Users\\someone\\repo',
			message: { id: 'msg_01ABC', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_01XYZ', name: 'mcp__claude_ai_Gmail__send', input: { to: 'x@y.com' } }] },
			snapshot: { trackedFileBackups: { 'C:\\Users\\someone\\repo\\a.ts': { v: 1 } } } });
		const all = JSON.stringify([a, b]);
		expect(findLeaks(all, ['someone', 'secret'])).toEqual([]);
		expect(b.parentUuid).toBe(a.uuid);
		expect(a.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(b.message.id).toMatch(/^msg_[0-9a-f]{5}$/);
		expect(b.message.content[0].id).toMatch(/^toolu_[0-9a-f]{5}$/);
		expect(a.timestamp).toBe(new Date(EPOCH).toISOString());
		expect(Date.parse(b.timestamp) - Date.parse(a.timestamp)).toBe(5000);
		expect([a.cwd, b.cwd, a.gitBranch]).toEqual(['/work/project-1', '/work/project-1', 'branch-1']);
		expect(b.message.content[0].name).toBe('mcp__server__tool');
		expect(b.message.model).toBe('claude-opus-5-5');
		expect(Object.keys(b.snapshot.trackedFileBackups)).toEqual(['k1']);
		expect(a.message.content).toHaveLength('mail me at someone@example.com about C:\\Users\\someone\\x'.length);
		expect(stringsOf(a)).toContain('human');
		expect(filler('ab\ncd')).toMatch(/^[a-z]{2}\n[a-z]{2}$/);
		expect(makeScrubber('another-salt').line({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444' }).uuid).not.toBe(a.uuid);
	});

	it('keeps a slash command\'s name and the tag skeleton, never its arguments', () => {
		const o = makeScrubber('s').line({ type: 'user', message: { content: '<command-name>/clear</command-name><command-args>my secret</command-args>' } });
		expect(o.message.content).toMatch(/^<command-name>\/clear<\/command-name><command-args>[a-z]+ [a-z]+<\/command-args>$/);
		expect(o.message.content).not.toContain('secret');
	});
});
