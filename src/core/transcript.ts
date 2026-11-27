// Claude Code's transcript format, read as a conversation (Session Sidecar — Chat Panel, step P0).
//
// A transcript is `~/.claude/projects/<cwd, every non-alphanumeric as "-">/<sessionId>.jsonl`, one
// JSON object per line. The format has no published contract, so this module is the one place that
// knows it, and it fails soft: a line it does not draw is returned as `skipped` with a label, and the
// caller counts the labels. Pure — no IO, no clock; the fixture under tests/fixtures/transcripts/ is
// what it is held to.
//
// What P0 measured (2026-11-27, every transcript on one machine: 104 files, 40 CLI versions from
// 2.1.170 to 2.1.332, ~70,000 lines) — see the CHANGELOG entry for the full finding:
// - 29 line `type`s. Only `user`, `assistant`, `system` and some `attachment`s are conversation;
//   the rest are session bookkeeping and are skipped by name.
// - An `assistant` line holds exactly ONE content block (always, in every version): a reply that
//   thinks, says something and calls two tools is four lines sharing `message.id`.
// - A tool call and its result are separate lines: `tool_use` on an assistant line, `tool_result`
//   on a user line, joined by `tool_use_id`. foldItems() pairs them.
// - The human's prompt is told from an injected `user` line by `origin.kind === "human"` (present
//   from 2.1.209). Lines without `origin` are classified by their flags and leading tag.
// - A prompt typed while a turn runs is NOT a user line: it is an `attachment` of type
//   `queued_command`, `commandMode: "prompt"`, `origin.kind: "human"`.
// - `thinking` text is usually not on disk (88% of blocks are empty, signature only).

export type ChatItem =
	| { kind: 'prompt'; id: string; ts: number; text: string }
	| { kind: 'reply'; id: string; ts: number; markdown: string }
	| { kind: 'thinking'; id: string; ts: number; text: string } // collapsed by default
	| { kind: 'tool'; id: string; ts: number; name: string; input: unknown;
		status: 'no-result-yet' | 'done' | 'error'; result?: { text: string; truncated: boolean } }
	| { kind: 'notice'; id: string; ts: number; text: string } // session start, mode change
	| { kind: 'skipped'; lineType: string }; // counted, never drawn

/** A tool result's text is cut to this many characters; `truncated` says it was. */
export const RESULT_MAX = 4000;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const skip = (lineType: string): ChatItem => ({ kind: 'skipped', lineType });

/** Milliseconds, or 0 when the line carries no usable time (several bookkeeping lines carry none;
 *  foldItems() gives those the time of the item before them). */
function tsOf(o: Obj): number {
	const t = Date.parse(str(o.timestamp));
	return Number.isFinite(t) ? t : 0;
}

/** A tool result's content: a string, or blocks of `text`, `image` and `tool_reference`. */
function resultText(content: unknown): { text: string; truncated: boolean } {
	let text: string;
	if (typeof content === 'string') text = content;
	else if (Array.isArray(content)) {
		text = content.map((b) => (!isObj(b) ? '' : b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]'
			: b.type === 'tool_reference' ? `[tool: ${str(b.tool_name) || '?'}]` : `[${str(b.type) || 'block'}]`)).filter(Boolean).join('\n');
	} else text = '';
	return text.length > RESULT_MAX ? { text: text.slice(0, RESULT_MAX), truncated: true } : { text, truncated: false };
}

/** The text of a user message: a string, or the text blocks of a list, with images marked. */
function userText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((b) => (!isObj(b) ? '' : b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

const between = (s: string, tag: string): string | null => {
	const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return m ? m[1]!.trim() : null;
};

/** Injected `user` lines that carry no `origin` announce themselves with a leading tag. Returns the
 *  item for a tagged line, or null for plain text. */
function taggedUser(text: string, id: string, ts: number): ChatItem | null {
	const t = text.trimStart();
	if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
		const name = between(t, 'command-name') ?? between(t, 'command-message') ?? '';
		const args = between(t, 'command-args') ?? '';
		return { kind: 'notice', id, ts, text: `${name}${args ? ` ${args}` : ''}` };
	}
	if (t.startsWith('<bash-input>')) return { kind: 'prompt', id, ts, text: `! ${between(t, 'bash-input') ?? ''}` };
	if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) {
		return { kind: 'notice', id, ts, text: [between(t, 'bash-stdout'), between(t, 'bash-stderr')].filter(Boolean).join('\n') };
	}
	if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) {
		return { kind: 'notice', id, ts, text: between(t, 'local-command-stdout') ?? between(t, 'local-command-stderr') ?? '' };
	}
	if (t.startsWith('<task-notification>')) return { kind: 'notice', id, ts, text: taskNotice(t) };
	if (t.startsWith('[Request interrupted')) return { kind: 'notice', id, ts, text: t.replace(/^\[|\]$/g, '') };
	if (/^<[a-z-]+>/.test(t)) return { kind: 'notice', id, ts, text: t.replace(/<\/?[a-z-]+>/g, ' ').trim() };
	return null;
}

const taskNotice = (t: string): string => {
	const summary = between(t, 'summary') ?? between(t, 'status') ?? '';
	return `Background task${summary ? `: ${summary}` : ' finished'}`;
};

function normaliseUser(o: Obj, id: string, ts: number): ChatItem[] {
	const msg = isObj(o.message) ? o.message : {};
	const content = msg.content;
	// A tool result. These carry no tool name; foldItems() joins them to their call.
	if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) {
		return content.filter(isObj).map((b) => (b.type === 'tool_result'
			? { kind: 'tool', id: str(b.tool_use_id), ts, name: '', input: undefined, status: b.is_error === true ? 'error' : 'done', result: resultText(b.content) }
			: skip(`user/${str(b.type) || 'block'}`)));
	}
	if (o.isMeta === true) return [skip('user/meta')]; // skill bodies, caveats, system reminders
	if (o.isCompactSummary === true) return [skip('user/compact-summary')]; // the compact_boundary is the notice
	const text = userText(content);
	const origin = isObj(o.origin) ? str(o.origin.kind) : '';
	if (origin === 'human') return [{ kind: 'prompt', id, ts, text }];
	if (origin === 'task-notification') return [{ kind: 'notice', id, ts, text: taskNotice(text) }];
	if (origin) return [{ kind: 'notice', id, ts, text: `${origin}: ${text}` }];
	// No origin: before 2.1.209, `claude -p` prompts (promptSource "sdk"), slash commands and their
	// output, `!` shell input, interruptions, and the brief that opens a sub-agent's own file.
	return [taggedUser(text, id, ts) ?? { kind: 'prompt', id, ts, text }];
}

function normaliseAssistant(o: Obj, uuid: string, ts: number): ChatItem[] {
	const msg = isObj(o.message) ? o.message : {};
	const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
	// An API error the CLI wrote as a reply (model "<synthetic>").
	if (o.isApiErrorMessage === true || msg.model === '<synthetic>') {
		return [{ kind: 'notice', id: uuid, ts, text: blocks.filter(isObj).map((b) => str(b.text)).filter(Boolean).join('\n') || 'API error' }];
	}
	return blocks.map((b, i): ChatItem => {
		const id = blocks.length > 1 ? `${uuid}:${i}` : uuid;
		if (!isObj(b)) return skip('assistant/block');
		if (b.type === 'text') return { kind: 'reply', id, ts, markdown: str(b.text) };
		if (b.type === 'thinking') return str(b.thinking) ? { kind: 'thinking', id, ts, text: str(b.thinking) } : skip('assistant/thinking-not-on-disk');
		if (b.type === 'tool_use') return { kind: 'tool', id: str(b.id) || id, ts, name: str(b.name), input: b.input, status: 'no-result-yet' };
		return skip(`assistant/${str(b.type) || 'block'}`);
	});
}

/** The `system` subtypes a reader shows; every other subtype is skipped by name. */
function normaliseSystem(o: Obj, id: string, ts: number): ChatItem[] {
	const sub = str(o.subtype);
	const content = str(o.content).replace(/<\/?[a-z-]+>/g, '').trim();
	if (sub === 'compact_boundary') {
		const trigger = isObj(o.compactMetadata) ? str(o.compactMetadata.trigger) : '';
		return [{ kind: 'notice', id, ts, text: `Conversation compacted${trigger ? ` (${trigger})` : ''}` }];
	}
	if (sub === 'local_command' || sub === 'informational' || sub === 'away_summary' || sub === 'model_refusal_no_fallback' || sub === 'scheduled_task_fire') {
		return content ? [{ kind: 'notice', id, ts, text: content }] : [skip(`system/${sub}`)];
	}
	return [skip(`system/${sub || '?'}`)];
}

/** Attachments are context Claude Code injected: skipped by attachment type — except a prompt the
 *  human typed while a turn was running, which is recorded only here. */
function normaliseAttachment(o: Obj, id: string, ts: number): ChatItem[] {
	const a = isObj(o.attachment) ? o.attachment : {};
	const type = str(a.type) || '?';
	if (type === 'queued_command') {
		const origin = isObj(a.origin) ? str(a.origin.kind) : '';
		const text = typeof a.prompt === 'string' ? a.prompt : userText(a.prompt);
		const at = Date.parse(str(a.timestamp));
		const when = Number.isFinite(at) ? at : ts;
		if (a.isMeta === true) return [skip('attachment/queued_command-meta')];
		if (a.commandMode === 'prompt' && (origin === 'human' || !origin)) return [{ kind: 'prompt', id, ts: when, text }];
		if (a.commandMode === 'task-notification' || origin === 'task-notification') return [{ kind: 'notice', id, ts: when, text: taskNotice(text) }];
		return [skip(`attachment/queued_command-${str(a.commandMode) || '?'}`)];
	}
	return [skip(`attachment/${type}`)];
}

/**
 * One transcript line → the chat items it holds. `ref` names the line for the lines that carry no
 * `uuid` of their own (the reader passes the byte offset), so every item has a stable, unique id.
 * Never throws: a line that is not JSON, or not an object, is `skipped`.
 */
export function normalise(line: string, ref: string | number = ''): ChatItem[] {
	let o: unknown;
	try { o = JSON.parse(line); } catch { return [skip('(unparseable)')]; }
	if (!isObj(o)) return [skip('(not an object)')];
	const type = str(o.type) || '(no type)';
	const id = str(o.uuid) || `${type}@${ref}`;
	const ts = tsOf(o);
	switch (type) {
		case 'user': return normaliseUser(o, id, ts);
		case 'assistant': return normaliseAssistant(o, id, ts);
		case 'system': return normaliseSystem(o, id, ts);
		case 'attachment': return normaliseAttachment(o, id, ts);
		case 'derived-from': {
			// Written when a session is resumed into the same file (`--continue`, `--resume`), and after
			// a compaction (via "compact", which the compact_boundary already shows).
			const via = Array.isArray(o.sessions) ? o.sessions.filter(isObj).map((s) => str(s.via)) : [];
			return via.includes('resume') ? [{ kind: 'notice', id, ts, text: 'Session resumed' }] : [skip(`derived-from/${via[0] ?? '?'}`)];
		}
		case 'continued-in': return [{ kind: 'notice', id, ts, text: `Continued in session ${str(o.continuedInSessionId)}` }];
		default: return [skip(type)];
	}
}

export interface Folded {
	/** Every drawable item in file order, a tool's result merged into its call. */
	items: Exclude<ChatItem, { kind: 'skipped' }>[];
	/** What was not drawn, by label. */
	skipped: Record<string, number>;
}

/**
 * Items from consecutive lines → the conversation. A `tool_result` is merged into the `tool_use` it
 * answers (same id); a result whose call is not in `items` — the reader started after it — stays as
 * its own tool item with an empty name. An item with no time takes the time of the one before it.
 * Pure: `items` is not modified.
 */
export function foldItems(items: readonly ChatItem[]): Folded {
	const out: Folded['items'] = [];
	const skipped: Record<string, number> = {};
	const tools = new Map<string, number>();
	let lastTs = 0;
	for (const it of items) {
		if (it.kind === 'skipped') { skipped[it.lineType] = (skipped[it.lineType] ?? 0) + 1; continue; }
		const ts = it.ts || lastTs;
		lastTs = ts;
		if (it.kind === 'tool' && it.status !== 'no-result-yet' && it.name === '' && tools.has(it.id)) {
			const at = tools.get(it.id)!;
			const call = out[at] as Extract<ChatItem, { kind: 'tool' }>;
			out[at] = { ...call, status: it.status, ...(it.result ? { result: it.result } : {}) };
			continue;
		}
		if (it.kind === 'tool') tools.set(it.id, out.length);
		out.push({ ...it, ts });
	}
	return { items: out, skipped };
}
