import { describe, it, expect } from 'vitest';
import { conversationLabel, archiveTitle, archiveWhen } from '../src/ui/archive-panel';
import type { ArchiveManifest } from '../src/terminals/worktree-archive';

const m = (over: Partial<ArchiveManifest> = {}): ArchiveManifest => ({
	version: 1, base: 'r__wt-main-1__20260730-011542', repo: 'r', repoPath: '/p/r',
	branch: 'wt/main-1', baseBranch: 'main', worktreePath: '/p/wt-main-1', projectSlug: '-p-wt-main-1',
	terminalName: 'main-1', archivedAt: '2026-07-30T01:15:42.000Z', archivedAtMs: 1_784_000_000_000,
	reason: 'sweep', headCommit: 'abc', headSubject: 'wip', parked: false, fileCount: 3,
	skippedFiles: [], zipBytes: 1024, rawBytes: 4096, conversations: [], ...over,
});

const convo = (over: Partial<ArchiveManifest['conversations'][number]> = {}): ArchiveManifest['conversations'][number] => ({
	sessionId: 's1', title: 'Fix the flaky poll test', firstTs: '', lastTs: '',
	userMessages: 3, assistantMessages: 5, hasSummary: false, ...over,
});

describe('archiveTitle', () => {
	it('prefers the conversation\'s opening ask', () => {
		expect(archiveTitle(m({ conversations: [convo()] }))).toBe('Fix the flaky poll test');
	});
	it('falls back to the branch when there is no usable title', () => {
		expect(archiveTitle(m())).toBe('wt/main-1');
		expect(archiveTitle(m({ conversations: [convo({ title: '(no user prompt recorded)' })] }))).toBe('wt/main-1');
		expect(archiveTitle(m({ conversations: [convo({ title: '   ' })] }))).toBe('wt/main-1');
	});
});

describe('conversationLabel', () => {
	it('counts conversations and total messages', () => {
		expect(conversationLabel(m({ conversations: [convo()] }))).toBe('1 conversation · 8 messages');
		expect(conversationLabel(m({ conversations: [convo(), convo({ userMessages: 1, assistantMessages: 0 })] })))
			.toBe('2 conversations · 9 messages');
	});
	it('says so when nothing was captured', () => {
		expect(conversationLabel(m())).toBe('no conversation captured');
	});
	it('treats a single message as singular', () => {
		expect(conversationLabel(m({ conversations: [convo({ userMessages: 1, assistantMessages: 0 })] })))
			.toBe('1 conversation · 1 message');
	});
});

describe('archiveWhen', () => {
	it('falls back to the raw value when the date is unparseable', () => {
		expect(archiveWhen(m({ archivedAt: 'whenever' }))).toBe('whenever');
	});
	it('renders a real date as something local', () => {
		expect(archiveWhen(m())).not.toBe('2026-07-30T01:15:42.000Z');
		expect(archiveWhen(m()).length).toBeGreaterThan(0);
	});
});
