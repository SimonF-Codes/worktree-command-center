/** Pure helpers for the connector channel — a request/receipt path for a LOCAL, NON-overseer
 *  process to ask the app to act, distinct from god-outbox (see god.ts's parseOutboxMessage).
 *
 *  Why a separate channel instead of writing through god-outbox too: god-outbox carries Kane's
 *  own privileged intent — `tell` into any terminal, `rename` anything, `personality` — because
 *  the overseer console *is* the app's own trusted UI. A connector is a different actor (e.g. a
 *  separate desktop app) that should be able to REQUEST work, not inherit the overseer's command
 *  set over every terminal on the floor. So: its own directory pair per connector
 *  (`connectors/<id>/requests` in, `connectors/<id>/receipts` out), its own narrower verb set
 *  (`spawn` + `tell` — deliberately not `watch`/`rename`/`personality`, which act on the
 *  operator's own workspace rather than requesting work from a terminal), and a registration list
 *  in config.json so an unknown id gets a rejected receipt instead of being silently honoured.
 *
 *  `tell` looks like it narrows the gap with Kane's own channel, so the asymmetry is worth being
 *  explicit about: a connector can only address a terminal by its exact live name (never create,
 *  rename, or retarget one), an ambiguous or journal target is rejected rather than guessed at
 *  (see resolveConnectorTellTarget), the message is size-capped, and every attempt gets a receipt
 *  — so unlike Kane's `tell`, there is no way for this to happen silently or at unbounded volume.
 *
 *  `new-tab` is a bigger grant than either, so it is not part of registration: it has to be
 *  granted by name (`grants: ["new-tab"]` on the connector's config entry). It adds a tab to the
 *  operator's own window and a target to the floor that `spawn` can then reach, and it can create
 *  a folder on disk. The folder is the smaller part — any local process already could — but the
 *  tab and the registration are the app's to give, so they are opt-in per connector, refused
 *  with a reason when not granted, and announced in the window when they happen. */

import { EFFORT_LEVELS } from './god';
import { parseNewTabFields, type NewTabFields, type NewTabResult } from '../new-tab';

/** Grants beyond spawn/tell a connector entry may carry. Unknown names are dropped on parse. */
export const CONNECTOR_GRANTS = ['new-tab'] as const;
export type ConnectorGrant = typeof CONNECTOR_GRANTS[number];

/** One entry from config.json's `connectors` list — a local trust boundary between the user's own
 *  apps, not authentication. */
export interface ConnectorConfig { id: string; label: string; grants?: ConnectorGrant[]; }

/** Tolerant parse of config.json's `connectors` key. Drops entries missing a valid id/label;
 *  never throws. */
export function parseConnectors(v: unknown): ConnectorConfig[] {
	if (!Array.isArray(v)) return [];
	const out: ConnectorConfig[] = [];
	for (const e of v) {
		if (!e || typeof e !== 'object') continue;
		const o = e as Record<string, unknown>;
		if (typeof o.id === 'string' && /^[a-z0-9-]+$/.test(o.id) && typeof o.label === 'string' && o.label.trim()) {
			const grants = Array.isArray(o.grants)
				? CONNECTOR_GRANTS.filter((g) => (o.grants as unknown[]).includes(g))
				: [];
			out.push({ id: o.id, label: o.label, ...(grants.length ? { grants } : {}) });
		}
	}
	return out;
}

/** The two verbs connectors get. `spawn` opens a NEW worktree terminal; `tell` delivers a
 *  message into one that's already open (the thing `cos-coord tell` does for the overseer,
 *  now reachable from outside). Deliberately NOT `watch`, `rename`, or `personality` — those
 *  act on the operator's own workspace (retargeting Kane's watchers, touching Kane's own mode),
 *  not requesting work from a terminal. */
export interface SpawnConnectorRequest {
	v: number; id: string; connector: string; sentMs: number; kind: 'spawn';
	repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null;
}

export interface TellConnectorRequest {
	v: number; id: string; connector: string; sentMs: number; kind: 'tell';
	terminal: string; message: string;
}

/** Open a workspace tab bound to a repo — see new-tab.ts. Needs the `new-tab` grant. */
export interface NewTabConnectorRequest {
	v: number; id: string; connector: string; sentMs: number; kind: 'new-tab';
	fields: NewTabFields;
}

export type ConnectorRequest = SpawnConnectorRequest | TellConnectorRequest | NewTabConnectorRequest;

export type ParsedConnectorRequest =
	| { ok: true; request: ConnectorRequest }
	| { ok: false; id: string | null; reason: string };

/** A paste-expanded message has jammed a terminal's input before (real incident, not
 *  hypothetical) — cap it well above any reasonable task/instruction so a connector bug or a
 *  runaway generation can't dump an entire file into someone's terminal. */
export const MAX_TELL_MESSAGE_LEN = 4000;

/** Parse one connector request file's contents. Unlike parseOutboxMessage (which just returns
 *  null on any problem — the outbox has no receipts, so a drop is invisible either way), this
 *  always tries to recover an `id` first so the caller can write a REJECTED receipt back with a
 *  reason instead of the request just vanishing. Only a request with no recoverable `id` produces
 *  no receipt — there is nothing to name the receipt file after. */
export function parseConnectorRequest(text: string): ParsedConnectorRequest {
	let o: Record<string, unknown>;
	try {
		const p: unknown = JSON.parse(text);
		if (!p || typeof p !== 'object') return { ok: false, id: null, reason: 'malformed request — not a JSON object' };
		o = p as Record<string, unknown>;
	} catch {
		return { ok: false, id: null, reason: 'malformed request — invalid JSON' };
	}
	const id = typeof o.id === 'string' && o.id.trim() ? o.id : null;
	if (!id) return { ok: false, id: null, reason: 'malformed request — missing "id"' };
	if (typeof o.connector !== 'string' || !o.connector.trim()) return { ok: false, id, reason: 'malformed request — missing "connector"' };
	if (typeof o.v !== 'number') return { ok: false, id, reason: 'malformed request — missing "v"' };
	if (typeof o.sentMs !== 'number') return { ok: false, id, reason: 'malformed request — missing "sentMs"' };
	const kind = typeof o.kind === 'string' ? o.kind : '';
	if (kind !== 'spawn' && kind !== 'tell' && kind !== 'new-tab') {
		return { ok: false, id, reason: `kind "${kind || '(missing)'}" is not permitted for connectors — only "spawn", "tell" or "new-tab" is` };
	}
	if (kind === 'new-tab') {
		const f = parseNewTabFields(o);
		if (!f.ok) return { ok: false, id, reason: f.reason };
		return { ok: true, request: { v: o.v, id, connector: o.connector, sentMs: o.sentMs, kind: 'new-tab', fields: f.fields } };
	}
	if (kind === 'tell') {
		if (typeof o.terminal !== 'string' || !o.terminal.trim() || typeof o.message !== 'string' || !o.message) {
			return { ok: false, id, reason: 'malformed tell request — "terminal" and "message" are required' };
		}
		if (o.message.length > MAX_TELL_MESSAGE_LEN) {
			return { ok: false, id, reason: `message is too long (${o.message.length} chars, max ${MAX_TELL_MESSAGE_LEN}) — trim it before sending` };
		}
		return { ok: true, request: { v: o.v, id, connector: o.connector, sentMs: o.sentMs, kind: 'tell', terminal: o.terminal.trim(), message: o.message } };
	}
	if (typeof o.repo !== 'string' || !o.repo.trim() || typeof o.task !== 'string' || !o.task) {
		return { ok: false, id, reason: 'malformed spawn request — "repo" and "task" are required' };
	}
	const base = typeof o.base === 'string' && o.base.trim() ? o.base : null;
	const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
	const effort = typeof o.effort === 'string' && o.effort.trim() ? o.effort.trim().toLowerCase() : null;
	const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
	return { ok: true, request: { v: o.v, id, connector: o.connector, sentMs: o.sentMs, kind: 'spawn', repo: o.repo, base, task: o.task, model, effort, name } };
}

/** One live terminal, as far as `tell` resolution needs to know about it. Journals are on the
 *  same roster (floor/INDEX.md lists them) but can't receive a message — same rule
 *  dispatchOutbox already applies to Kane's own `tell`. */
export interface LiveTerminal { name: string; isJournal: boolean; }

export type TellResolution = { ok: true; name: string } | { ok: false; reason: string };

/** Resolve a `tell` target the way a connector needs to, which is stricter than Kane's own
 *  resolveTellTarget (god.ts): Kane is a single trusted actor picking from a list he can also
 *  read himself, so silently taking the first case-insensitive match is fine. A connector's
 *  request has to come back with a reason if that pick would have been a guess — so an
 *  ambiguous case-insensitive match is its own rejection, not resolved arbitrarily. */
export function resolveConnectorTellTarget(target: string, terminals: LiveTerminal[]): TellResolution {
	const notATerminal = (name: string): TellResolution =>
		({ ok: false, reason: `"${name}" is a journal tile, not a terminal — it can't accept a message` });
	const exact = terminals.find((t) => t.name === target);
	if (exact) return exact.isJournal ? notATerminal(exact.name) : { ok: true, name: exact.name };
	const lc = target.toLowerCase();
	const matches = terminals.filter((t) => t.name.toLowerCase() === lc);
	if (matches.length === 0) {
		const live = terminals.map((t) => t.name).join(', ') || '(none)';
		return { ok: false, reason: `no such terminal "${target}". Live: ${live}` };
	}
	if (matches.length > 1) {
		return { ok: false, reason: `"${target}" is ambiguous — matches ${matches.map((m) => m.name).join(', ')}` };
	}
	return matches[0].isJournal ? notATerminal(matches[0].name) : { ok: true, name: matches[0].name };
}

export type ConnectorOutcome =
	| { status: 'accepted'; id: string; request: ConnectorRequest }
	| { status: 'rejected'; id: string | null; reason: string };

/** The whole accept/reject decision, IO-free: parse the envelope, then check it against what only
 *  the app knows — which connector ids are registered, which repos exist, which terminals are
 *  live. Registration is checked before anything else so an unregistered connector never learns
 *  the floor's repo list OR its terminal roster. For `tell`, the accepted request's `terminal` is
 *  normalized to the resolved live name (case-insensitively matched), so the caller can act on it
 *  directly without re-resolving. The one thing this can't decide is whether a spawn/delivery
 *  actually succeeds (that needs the filesystem/PTY) — the caller finishes that part and writes
 *  the final receipt. */
export function evaluateConnectorRequest(
	text: string,
	opts: { connectorId: string; registeredConnectorIds: string[]; knownRepoNames: string[]; liveTerminals?: LiveTerminal[]; grants?: readonly string[] },
): ConnectorOutcome {
	const parsed = parseConnectorRequest(text);
	if (!parsed.ok) return { status: 'rejected', id: parsed.id, reason: parsed.reason };
	const { request } = parsed;
	if (!opts.registeredConnectorIds.includes(opts.connectorId)) {
		return { status: 'rejected', id: request.id, reason: `connector "${opts.connectorId}" is not registered` };
	}
	if (request.kind === 'new-tab') {
		// The repo lookup, folder checks and creation need the app's state and the disk, so they
		// happen in the app (new-tab.ts planNewTab) once this says the connector may ask at all.
		if (!(opts.grants ?? []).includes('new-tab')) {
			return { status: 'rejected', id: request.id, reason: `connector "${opts.connectorId}" is not granted "new-tab" — add "grants": ["new-tab"] to its entry in config.json and restart the app` };
		}
		return { status: 'accepted', id: request.id, request };
	}
	if (request.kind === 'tell') {
		const resolved = resolveConnectorTellTarget(request.terminal, opts.liveTerminals ?? []);
		if (!resolved.ok) return { status: 'rejected', id: request.id, reason: resolved.reason };
		return { status: 'accepted', id: request.id, request: { ...request, terminal: resolved.name } };
	}
	const repoKnown = opts.knownRepoNames.some((n) => n === request.repo || n.toLowerCase() === request.repo.toLowerCase());
	if (!repoKnown) {
		return { status: 'rejected', id: request.id, reason: `unknown repo "${request.repo}". Known: ${opts.knownRepoNames.join(', ') || '(none)'}` };
	}
	if (request.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(request.effort)) {
		return { status: 'rejected', id: request.id, reason: `invalid effort "${request.effort}". Valid: ${EFFORT_LEVELS.join(', ')}` };
	}
	return { status: 'accepted', id: request.id, request };
}

/** `terminalName` is the terminal a `spawn` created or a `tell` was delivered into — present on
 *  every `accepted` spawn/tell receipt. An accepted `new-tab` carries `newTab` instead; a rejected
 *  one carries `leftOnDisk` when a folder WAS created (a repo whose initial commit failed). */
export interface ConnectorReceipt {
	v: 1; id: string; status: 'accepted' | 'rejected'; reason?: string; terminalName?: string; handledMs: number;
	newTab?: NewTabResult; leftOnDisk?: string;
}

/** A receipt filename derived from a sender-chosen `id`, sanitized to a single safe path
 *  component — the id itself may contain anything, so this must never let it escape the receipts
 *  directory (no `/`, `\`, or `..`). */
export function receiptFilename(id: string): string {
	const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
	return `${safe || '_'}.json`;
}

/** Receipts are the connector's to clean up; prune anything older than this on drain so the
 *  directory cannot grow forever if a connector never reads them. */
export const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isReceiptStale(handledMs: number, now: number, maxAgeMs: number = RECEIPT_MAX_AGE_MS): boolean {
	return now - handledMs > maxAgeMs;
}
