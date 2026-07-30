import { describe, it, expect } from 'vitest';
import {
	projectSlug, projectDirFor, digestTranscript, oneLine, formatConversationSummary,
} from '../src/terminals/conversation-archive';

describe('projectSlug', () => {
	it('matches how Claude Code names a project dir (every non-alphanumeric → "-")', () => {
		// Verified against a real ~/.claude/projects entry.
		expect(projectSlug('C:\\Users\\me\\OneDrive\\Documents\\Claude\\QMK-Flasher\\.claude-worktrees\\QMK-Flasher\\wt-main-3'))
			.toBe('C--Users-me-OneDrive-Documents-Claude-QMK-Flasher--claude-worktrees-QMK-Flasher-wt-main-3');
		expect(projectSlug('/home/me/p/.claude-worktrees/r/wt-main-1')).toBe('-home-me-p--claude-worktrees-r-wt-main-1');
	});
	it('builds the transcript dir under the given home', () => {
		expect(projectDirFor('/a/b', '/home/me').replace(/\\/g, '/')).toBe('/home/me/.claude/projects/-a-b');
	});
});

describe('oneLine', () => {
	it('collapses whitespace, drops system reminders, and truncates', () => {
		expect(oneLine('  add   a\nthing  ')).toBe('add a thing');
		expect(oneLine('do it <system-reminder>ignore me</system-reminder> now')).toBe('do it now');
		expect(oneLine('x'.repeat(200), 10)).toBe('xxxxxxxxx…');
	});
});

const line = (o: unknown): string => JSON.stringify(o);

describe('digestTranscript', () => {
	it('extracts the title, prompts, counts and metadata from a transcript', () => {
		const jsonl = [
			line({ type: 'queue-operation', timestamp: '2026-07-28T23:11:30.446Z', sessionId: 'sid-1' }),
			line({ type: 'user', timestamp: '2026-07-28T23:11:31Z', sessionId: 'sid-1', gitBranch: 'wt/main-2', version: '2.1.0', message: { role: 'user', content: 'Add the ability to rename tabs' } }),
			line({ type: 'assistant', timestamp: '2026-07-28T23:11:40Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
			line({ type: 'user', timestamp: '2026-07-28T23:12:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Also zip old worktrees' }] } }),
			line({ type: 'assistant', timestamp: '2026-07-28T23:13:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
		].join('\n');
		const d = digestTranscript(jsonl);
		expect(d.sessionId).toBe('sid-1');
		expect(d.title).toBe('Add the ability to rename tabs');
		expect(d.prompts).toEqual(['Add the ability to rename tabs', 'Also zip old worktrees']);
		expect(d.userMessages).toBe(2);
		expect(d.assistantMessages).toBe(2);
		expect(d.gitBranch).toBe('wt/main-2');
		expect(d.cliVersion).toBe('2.1.0');
		expect(d.firstTs).toBe('2026-07-28T23:11:30.446Z');
		expect(d.lastTs).toBe('2026-07-28T23:13:00Z');
	});

	it('ignores machine chatter so it never becomes the conversation title', () => {
		const jsonl = [
			line({ type: 'user', timestamp: '1', message: { role: 'user', content: '<system-reminder>background note</system-reminder>' } }),
			line({ type: 'user', timestamp: '2', message: { role: 'user', content: '<command-name>/loop</command-name>' } }),
			line({ type: 'user', timestamp: '3', message: { role: 'user', content: 'Caveat: the messages below were generated…' } }),
			line({ type: 'user', timestamp: '4', message: { role: 'user', content: '[Request interrupted by user]' } }),
			line({ type: 'user', timestamp: '5', message: { role: 'user', content: 'the real ask' } }),
		].join('\n');
		const d = digestTranscript(jsonl);
		expect(d.userMessages).toBe(1);
		expect(d.title).toBe('the real ask');
	});

	it('keeps Claude\'s own compaction summaries', () => {
		const d = digestTranscript(line({ type: 'summary', timestamp: '1', summary: 'Refactored the archive sweep.' }));
		expect(d.compactSummaries).toEqual(['Refactored the archive sweep.']);
	});

	it('survives damaged lines and an empty transcript', () => {
		const d = digestTranscript('not json\n\n{"broken":\n' + line({ type: 'user', timestamp: '1', message: { role: 'user', content: 'ok' } }));
		expect(d.userMessages).toBe(1);
		const empty = digestTranscript('', 'fallback-id');
		expect(empty.sessionId).toBe('fallback-id');
		expect(empty.title).toBe('(no user prompt recorded)');
	});

	it('caps the prompt list so a 500-turn session still yields a small summary', () => {
		const many = Array.from({ length: 50 }, (_, i) => line({ type: 'user', timestamp: String(i), message: { role: 'user', content: `ask ${i}` } })).join('\n');
		const d = digestTranscript(many);
		expect(d.userMessages).toBe(50);
		expect(d.prompts).toHaveLength(8);
	});
});

describe('formatConversationSummary', () => {
	const meta = {
		repo: 'my-app', branch: 'wt/main-3', worktreePath: 'C:/p/.claude-worktrees/my-app/wt-main-3',
		archivedAt: '2026-07-30T01:15:42.000Z', headSubject: 'wip: auto-parked', parked: true,
		fileCount: 12, rawBytes: 4096,
	};

	it('reads as a standalone document about the branch and its conversation', () => {
		const out = formatConversationSummary(meta, [digestTranscript([
			line({ type: 'user', timestamp: '2026-07-29T10:00:00Z', sessionId: 'sid-9', message: { role: 'user', content: 'Fix the flaky test' } }),
			line({ type: 'summary', timestamp: '2026-07-29T11:00:00Z', summary: 'Found a race in the poll loop.' }),
		].join('\n'))]);
		expect(out).toContain('# Archived worktree — my-app / wt/main-3');
		expect(out).toContain('wt/main-3');
		expect(out).toContain('auto-parked');
		expect(out).toContain('4.0 KB uncompressed');
		expect(out).toContain('## Fix the flaky test');
		expect(out).toContain('Found a race in the poll loop.');
		expect(out).toContain('sid-9');
		expect(out).toContain('Revive');
	});

	it('says so plainly when no transcript was captured', () => {
		const out = formatConversationSummary(meta, []);
		expect(out).toContain('No Claude Code transcript was found');
	});
});
