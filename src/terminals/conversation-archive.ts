/** Capturing (and summarizing) the Claude Code conversation that belongs to a worktree.
 *
 *  A terminal's conversation isn't stored by this app — `claude --continue` finds it by CWD, in
 *  `~/.claude/projects/<slug(cwd)>/`. So archiving a worktree has to take that directory with it,
 *  and reviving one has to put it back at the SAME worktree path or `--continue` won't match.
 *
 *  Everything above the `readTranscript*` helpers is pure text/JSON work so it unit-tests without
 *  a real transcript on disk.
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

/** How Claude Code names a project directory: every non-alphanumeric byte of the absolute CWD
 *  becomes '-'. `C:\Users\me\p\.claude-worktrees\r\wt-main-1` →
 *  `C--Users-me-p--claude-worktrees-r-wt-main-1`. */
export function projectSlug(cwd: string): string {
	return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** The directory holding a CWD's transcripts. */
export function projectDirFor(cwd: string, home: string = os.homedir()): string {
	return path.join(home, '.claude', 'projects', projectSlug(cwd));
}

/** One parsed conversation, distilled from a .jsonl transcript. */
export interface ConversationDigest {
	sessionId: string;
	/** A one-line human title — the opening user prompt, trimmed. */
	title: string;
	firstTs: string;
	lastTs: string;
	userMessages: number;
	assistantMessages: number;
	/** Claude's own compaction summaries, if the conversation was long enough to have any. */
	compactSummaries: string[];
	/** The opening user prompts, in order — what the session was actually asked to do. */
	prompts: string[];
	gitBranch: string;
	cliVersion: string;
}

/** Content blocks we may see on a message; only text matters for a summary. */
type Block = { type?: string; text?: string };

function blockText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return (content as Block[])
		.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text!)
		.join('\n');
}

/** Machine chatter that shouldn't be mistaken for something the human asked for. */
function isNoisePrompt(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (t.startsWith('<system-reminder>')) return true;
	if (t.startsWith('<command-name>') || t.startsWith('<local-command')) return true;
	if (t.startsWith('Caveat:')) return true;
	if (t.startsWith('[Request interrupted')) return true;
	if (/^tool_result\b/.test(t)) return true;
	return false;
}

/** Collapse a prompt to a single readable line of at most `max` chars. */
export function oneLine(text: string, max = 120): string {
	const s = String(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/\s+/g, ' ').trim();
	return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/** Parse a transcript's JSONL text into a digest. Unknown/damaged lines are skipped, so a
 *  partially-written transcript still summarizes. */
export function digestTranscript(jsonl: string, sessionIdFallback = ''): ConversationDigest {
	const d: ConversationDigest = {
		sessionId: sessionIdFallback, title: '', firstTs: '', lastTs: '',
		userMessages: 0, assistantMessages: 0, compactSummaries: [], prompts: [],
		gitBranch: '', cliVersion: '',
	};
	for (const line of String(jsonl).split('\n')) {
		if (!line.trim()) continue;
		let o: Record<string, unknown>;
		try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

		const ts = typeof o.timestamp === 'string' ? o.timestamp : '';
		if (ts) { if (!d.firstTs) d.firstTs = ts; d.lastTs = ts; }
		if (!d.sessionId && typeof o.sessionId === 'string') d.sessionId = o.sessionId;
		if (!d.gitBranch && typeof o.gitBranch === 'string' && o.gitBranch) d.gitBranch = o.gitBranch;
		if (!d.cliVersion && typeof o.version === 'string' && o.version) d.cliVersion = o.version;

		if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) {
			d.compactSummaries.push(o.summary.trim());
			continue;
		}
		const msg = o.message as { role?: string; content?: unknown } | undefined;
		if (o.type === 'user' && msg?.role === 'user') {
			const text = blockText(msg.content);
			if (isNoisePrompt(text)) continue;
			d.userMessages++;
			if (d.prompts.length < 8) d.prompts.push(oneLine(text, 240));
			continue;
		}
		if (o.type === 'assistant' && msg?.role === 'assistant') d.assistantMessages++;
	}
	d.title = d.prompts[0] ? oneLine(d.prompts[0], 100) : '(no user prompt recorded)';
	return d;
}

/** The human-readable summary written BESIDE the zip (and again inside it). Kept as markdown and
 *  a few KB at most: browsing archives must never require inflating an archive. */
export function formatConversationSummary(meta: {
	repo: string; branch: string; worktreePath: string; archivedAt: string;
	headSubject: string; parked: boolean; fileCount: number;
	/** Uncompressed total. Deliberately NOT the zip size — the summary goes inside the very zip
	 *  it describes, so its compressed size can't be known while it's being written. */
	rawBytes: number;
}, convos: ConversationDigest[]): string {
	const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const lines: string[] = [];
	lines.push(`# Archived worktree — ${meta.repo} / ${meta.branch}`);
	lines.push('');
	lines.push(`- **Archived:** ${meta.archivedAt}`);
	lines.push(`- **Original path:** \`${meta.worktreePath}\``);
	lines.push(`- **Branch:** \`${meta.branch}\` (kept in the repo — commits are not in this zip only)`);
	lines.push(`- **HEAD:** ${meta.headSubject || '(unknown)'}`);
	if (meta.parked) lines.push('- **Uncommitted work:** was auto-parked as a `wip:` commit before archiving');
	lines.push(`- **Contents:** ${meta.fileCount} file(s), ${kb(meta.rawBytes)} uncompressed`);
	lines.push(`- **Conversations captured:** ${convos.length}`);
	lines.push('');

	if (!convos.length) {
		lines.push('_No Claude Code transcript was found for this worktree._');
		return lines.join('\n') + '\n';
	}

	for (const c of convos) {
		lines.push(`## ${c.title}`);
		lines.push('');
		lines.push(`- Session \`${c.sessionId}\``);
		lines.push(`- ${c.firstTs || '?'} → ${c.lastTs || '?'}`);
		lines.push(`- ${c.userMessages} user / ${c.assistantMessages} assistant messages${c.cliVersion ? ` · CLI ${c.cliVersion}` : ''}`);
		lines.push('');
		if (c.compactSummaries.length) {
			lines.push('**What happened (Claude\'s own summary):**');
			lines.push('');
			for (const s of c.compactSummaries) { lines.push(s); lines.push(''); }
		}
		if (c.prompts.length) {
			lines.push('**Asked to do:**');
			lines.push('');
			for (const p of c.prompts) lines.push(`- ${p}`);
			lines.push('');
		}
	}
	lines.push('---');
	lines.push('');
	lines.push('Revive this from the app: **🗄 Archive → Revive**. That recreates the worktree at the');
	lines.push('original path, restores the transcript, and opens a terminal on `claude --continue`, so');
	lines.push('the conversation picks up where it stopped.');
	return lines.join('\n') + '\n';
}

/** Every file under a directory, as archive-relative posix paths. Returns [] if it doesn't exist. */
export async function listFilesRecursive(root: string, rel = ''): Promise<string[]> {
	let names: import('fs').Dirent[];
	try { names = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
	const out: string[] = [];
	for (const e of names) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...await listFilesRecursive(root, r));
		else if (e.isFile()) out.push(r);
	}
	return out;
}

/** Read + digest every `<session>.jsonl` transcript in a worktree's project dir. */
export async function readConversations(worktreePath: string, home: string = os.homedir()): Promise<ConversationDigest[]> {
	const dir = projectDirFor(worktreePath, home);
	const files = (await listFilesRecursive(dir)).filter((f) => f.endsWith('.jsonl') && !f.includes('/'));
	const out: ConversationDigest[] = [];
	for (const f of files) {
		try {
			const text = await fsp.readFile(path.join(dir, f), 'utf8');
			out.push(digestTranscript(text, path.basename(f, '.jsonl')));
		} catch { /* unreadable transcript — the others still summarize */ }
	}
	return out.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
}
