/** Pure helpers for the connector channel — a request/receipt path for a LOCAL, NON-overseer
 *  process to ask the app to act, distinct from god-outbox (see god.ts's parseOutboxMessage).
 *
 *  Why a separate channel instead of writing through god-outbox too: god-outbox carries Kane's
 *  own privileged intent — `tell` into any terminal, `rename` anything, `personality` — because
 *  the overseer console *is* the app's own trusted UI. A connector is a different actor (e.g. a
 *  separate desktop app) that should be able to REQUEST work, not inherit the overseer's command
 *  set over every terminal on the floor. So: its own directory pair per connector
 *  (`connectors/<id>/requests` in, `connectors/<id>/receipts` out), its own narrower verb set
 *  (`spawn` only, so far — deliberately not tell/rename/personality), and a registration list in
 *  config.json so an unknown id gets a rejected receipt instead of being silently honoured. */

import { EFFORT_LEVELS } from './god';

/** One entry from config.json's `connectors` list — a local trust boundary between the user's own
 *  apps, not authentication. */
export interface ConnectorConfig { id: string; label: string; }

/** Tolerant parse of config.json's `connectors` key. Drops entries missing a valid id/label;
 *  never throws. */
export function parseConnectors(v: unknown): ConnectorConfig[] {
	if (!Array.isArray(v)) return [];
	const out: ConnectorConfig[] = [];
	for (const e of v) {
		if (!e || typeof e !== 'object') continue;
		const o = e as Record<string, unknown>;
		if (typeof o.id === 'string' && /^[a-z0-9-]+$/.test(o.id) && typeof o.label === 'string' && o.label.trim()) {
			out.push({ id: o.id, label: o.label });
		}
	}
	return out;
}

/** The one verb connectors get. */
export interface ConnectorRequest {
	v: number; id: string; connector: string; sentMs: number; kind: 'spawn';
	repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null;
}

export type ParsedConnectorRequest =
	| { ok: true; request: ConnectorRequest }
	| { ok: false; id: string | null; reason: string };

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
	if (kind !== 'spawn') {
		return { ok: false, id, reason: `kind "${kind || '(missing)'}" is not permitted for connectors — only "spawn" is` };
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

export type ConnectorOutcome =
	| { status: 'accepted'; id: string; request: ConnectorRequest }
	| { status: 'rejected'; id: string | null; reason: string };

/** The whole accept/reject decision, IO-free: parse the envelope, then check it against what only
 *  the app knows — which connector ids are registered and which repos exist. Registration is
 *  checked before the repo so an unregistered connector never learns anything about the floor's
 *  repo list. The one thing this can't decide is whether the spawn itself succeeds (that needs the
 *  filesystem) — the caller finishes that part and writes the final receipt. */
export function evaluateConnectorRequest(
	text: string,
	opts: { connectorId: string; registeredConnectorIds: string[]; knownRepoNames: string[] },
): ConnectorOutcome {
	const parsed = parseConnectorRequest(text);
	if (!parsed.ok) return { status: 'rejected', id: parsed.id, reason: parsed.reason };
	const { request } = parsed;
	if (!opts.registeredConnectorIds.includes(opts.connectorId)) {
		return { status: 'rejected', id: request.id, reason: `connector "${opts.connectorId}" is not registered` };
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

export interface ConnectorReceipt {
	v: 1; id: string; status: 'accepted' | 'rejected'; reason?: string; terminalName?: string; handledMs: number;
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
