// The scrubber for the transcript fixtures (Chat Panel P0). A transcript is a record of real
// conversations; a fixture must carry its STRUCTURE and none of its CONTENT. Run it to re-capture:
//
//   node tests/fixtures/transcripts/scrub.mjs <source.jsonl> <out.jsonl> --lines <from>:<to> [--lines …]
//
// Lines are 0-based and <to> is exclusive; several ranges are concatenated in order. The source path
// is never written anywhere. Every capture uses a fresh random salt, so a scrubbed id cannot be
// matched back to the real one — but within one capture the mapping is consistent, so `parentUuid`
// chains and `tool_use_id` pairings survive.
//
// It is an ALLOW-list, not a deny-list:
//   - A string is kept only under a key in SAFE_KEYS, and only if it looks like an enum value
//     (letters, digits, `_ . - < >`, no spaces, no slashes, no `@`, 64 characters at most).
//   - Strings under ID_KEYS are remapped to synthetic ids of the same shape (prefix and uuid dashes kept).
//   - `timestamp`-like ISO strings, and epoch-millisecond numbers, are shifted so the capture starts
//     at 2030-01-01T00:00:00Z; the gaps between lines are kept.
//   - `cwd` becomes /work/project-N, `gitBranch` becomes branch-N (main/master/HEAD kept).
//   - A tool name is kept if it is a built-in's PascalCase name; an MCP tool becomes mcp__server__tool.
//   - A slash command's name (`/clear`, `/compact`) is kept; its arguments are not.
//   - Every other string — messages, thinking, tool input and output, titles, file paths, slugs —
//     becomes filler: each character that is not whitespace or markdown punctuation is replaced by a
//     letter of "lorem ipsum…", cut to 400 characters. The text's shape (length, line breaks) stays.
//   - An object key that is not a plain identifier (a file path used as a key, a model id) becomes kN.
//   - Arrays longer than 12 are cut to 12 (bookkeeping lines only carry long arrays).
// After scrubbing, findLeaks() checks the output for e-mail addresses, absolute paths, this machine's
// home directory and user name, and the names of the local project folders; if it finds any, nothing
// is written.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAFE_KEYS = new Set([
	'type', 'subtype', 'level', 'role', 'stop_reason', 'operation', 'version', 'userType', 'entrypoint', 'promptSource',
	'turnOrigin', 'permissionMode', 'mode', 'kind', 'via', 'trigger', 'toolDenialKind', 'thinkingDisplay', 'effort',
	'perTurnEffort', 'sessionKind', 'model', 'commandMode', 'decision', 'source', 'reasonType', 'media_type',
	'querySource', 'renderedRole', 'agentType', 'subagent_type', 'atis', 'status', 'rowSource', 'reasonCode',
]);
export const ID_KEYS = new Set([
	'uuid', 'parentUuid', 'logicalParentUuid', 'sessionId', 'session_id', 'promptId', 'turnPromptId', 'tool_use_id', 'id',
	'messageId', 'snapshotMessageId', 'requestId', 'sourceToolAssistantUUID', 'sourceToolUseID', 'toolUseID', 'agentId',
	'leafUuid', 'continuedInSessionId', 'source_uuid', 'delivery_id', 'bridgeSessionId', 'accountUuid', 'organizationUuid',
	'ownerAccountUuid', 'ownerOrganizationUuid', 'requestRef', 'interruptedMessageId', 'refusedMessageId', 'taskId',
	'backgroundTaskId', 'hash', 'shapeHash', 'requestDigest', 'runId', 'reminderId', 'commandUuid', 'deliveryId', 'task_id',
]);
/** The tags Claude Code wraps injected user text in; kept so the normaliser's tag rules are exercised. */
export const KEPT_TAGS = ['command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr',
	'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'task-id', 'tool-use-id',
	'output-file', 'status', 'summary', 'event', 'note', 'result', 'usage', 'system-reminder'];
const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
const SAFE_VALUE = /^[A-Za-z0-9_.<>-]{0,64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;
const FILLER = 'loremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididuntutlaboreetdoloremagnaaliqua';
const KEEP_CHAR = /[\s#*`>|-]/;
export const STRING_MAX = 400;
export const ARRAY_MAX = 12;
export const EPOCH = Date.parse('2030-01-01T00:00:00Z');

export function filler(s) {
	let out = '';
	let i = 0;
	for (const ch of s.slice(0, STRING_MAX)) out += KEEP_CHAR.test(ch) ? ch : FILLER[i++ % FILLER.length];
	return out;
}

export function makeScrubber(salt = crypto.randomBytes(16).toString('hex')) {
	const ids = new Map();
	const cwds = new Map();
	const branches = new Map();
	let shift = null;
	const hex = (v, n) => crypto.createHmac('sha256', salt).update(v).digest('hex').repeat(4).slice(0, n);
	const mapId = (v) => {
		if (!ids.has(v)) {
			const prefix = (v.match(/^(?:[a-z]+_|agent-)/) || [''])[0];
			const body = v.slice(prefix.length);
			const h = hex(v, body.length);
			ids.set(v, prefix + [...body].map((c, i) => (c === '-' ? '-' : h[i])).join(''));
		}
		return ids.get(v);
	};
	const time = (ms) => {
		if (shift === null) shift = EPOCH - ms;
		return ms + shift;
	};
	const text = (s) => {
		if (INTERRUPTED.test(s)) return s;
		// Keep the tag skeleton of injected user text, the name of a slash command, filler for the rest.
		const re = new RegExp(`(</?(?:${KEPT_TAGS.join('|')})>)`, 'g');
		return s.split(re).map((part, i, all) => {
			if (i % 2 === 1) return part;
			if (all[i - 1] === '<command-name>' || all[i - 1] === '<command-message>') {
				const m = part.match(/^\/?[a-z][a-z-]{0,30}$/);
				if (m) return part;
			}
			return filler(part);
		}).join('');
	};
	const toolName = (n) => (/^[A-Z][A-Za-z]{1,40}$/.test(n) ? n : n.startsWith('mcp__') ? 'mcp__server__tool' : filler(n));

	function value(v, key, parent) {
		if (v === null || typeof v === 'boolean') return v;
		if (typeof v === 'number') return v > 1.6e12 && v < 2.1e12 && Number.isInteger(v) ? time(v) : v;
		if (typeof v === 'string') {
			if (ISO.test(v)) return new Date(time(Date.parse(v))).toISOString();
			if (ID_KEYS.has(key)) return mapId(v);
			if (key === 'cwd') { if (!cwds.has(v)) cwds.set(v, `/work/project-${cwds.size + 1}`); return cwds.get(v); }
			if (key === 'gitBranch') {
				if (/^(main|master|HEAD)$/.test(v)) return v;
				if (!branches.has(v)) branches.set(v, `branch-${branches.size + 1}`);
				return branches.get(v);
			}
			if ((key === 'name' && parent && parent.type === 'tool_use') || key === 'tool_name') return toolName(v);
			if (SAFE_KEYS.has(key) && SAFE_VALUE.test(v) && !v.includes('@')) return v;
			if (key === 'signature') return filler(v.slice(0, 32));
			return text(v);
		}
		if (Array.isArray(v)) return v.slice(0, ARRAY_MAX).map((x) => value(x, key, parent));
		if (typeof v === 'object') {
			const out = {};
			let k = 0;
			for (const [kk, vv] of Object.entries(v)) out[IDENT.test(kk) ? kk : `k${++k}`] = value(vv, kk, v);
			return out;
		}
		return null;
	}
	return { line: (o) => value(o, '', null) };
}

/** Every string value in a parsed line (keys are identifiers by construction, so are not searched). */
export function stringsOf(v, out = []) {
	if (typeof v === 'string') out.push(v);
	else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
	else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
	return out;
}

/** What a scrubbed capture must not contain. `extra` are machine-specific terms (folder names),
 *  looked for in string VALUES only — a key such as "usage" is the format's, not the machine's. */
export function findLeaks(text, extra = []) {
	const found = [];
	const checks = [
		['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
		['Windows absolute path', /\b[A-Za-z]:(\\\\|\/)/],
		['home-directory path', /\/(Users|home)\/[A-Za-z]/],
	];
	for (const [what, re] of checks) { const m = text.match(re); if (m) found.push(`${what}: ${m[0].slice(0, 3)}…`); }
	const values = text.split('\n').filter((l) => l.trim()).flatMap((l) => stringsOf(JSON.parse(l))).join('\n').toLowerCase();
	for (const t of extra) if (t && values.includes(t.toLowerCase())) found.push(`machine term (${t.length} chars)`);
	return found;
}

/** The terms of this machine that must not survive: home dir, user name, project folder words. */
export function machineTerms() {
	const terms = new Set([os.homedir(), os.userInfo().username]);
	const generic = new Set(['claude', 'worktrees', 'worktree', 'origin', 'master', 'users', 'appdata', 'roaming', 'local', 'default', 'coordination', 'memory', 'feat', 'learn', 'tutor', 'command', 'center', 'project', 'projects', 'temp', 'documents',
		...KEPT_TAGS.flatMap((t) => t.split('-'))]); // a kept tag is the format's word, not the machine's
	try {
		for (const d of fs.readdirSync(path.join(os.homedir(), '.claude', 'projects'))) {
			for (const w of d.split(/[^A-Za-z0-9]+/)) if (w.length >= 5 && !/^\d+$/.test(w) && !generic.has(w.toLowerCase())) terms.add(w);
		}
	} catch { /* no projects folder: the generic checks still run */ }
	return [...terms];
}

function main(argv) {
	const [src, out, ...rest] = argv;
	const ranges = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] !== '--lines' || !/^\d+:\d+$/.test(rest[i + 1] ?? '')) throw new Error('usage: scrub.mjs <source.jsonl> <out.jsonl> --lines <from>:<to> [--lines …]');
		const [a, b] = rest[++i].split(':').map(Number);
		ranges.push([a, b]);
	}
	if (!src || !out || !ranges.length) throw new Error('usage: scrub.mjs <source.jsonl> <out.jsonl> --lines <from>:<to> [--lines …]');
	const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
	const s = makeScrubber();
	const picked = ranges.flatMap(([a, b]) => lines.slice(a, b));
	const body = `${picked.map((l) => JSON.stringify(s.line(JSON.parse(l)))).join('\n')}\n`;
	const leaks = findLeaks(body, machineTerms());
	if (leaks.length) { process.stderr.write(`scrub: refused to write ${out}: ${leaks.join('; ')}\n`); process.exitCode = 1; return; }
	fs.writeFileSync(out, body);
	process.stdout.write(`scrub: wrote ${picked.length} lines to ${path.basename(out)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
