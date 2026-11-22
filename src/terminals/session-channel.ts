/** The per-session request channel (V2 Team Floor step 10), the thin IO half. Every decision is
 *  made in core/session-requests.ts (and core/proposals.ts); this drains, claims, acts through the
 *  grid's callbacks, and writes a receipt for every attempt.
 *
 *  Layout, per workspace coordination directory:
 *
 *    sessions/<sessionId>/requests/<id>.json   in  — written by `cos-coord` from that session
 *    sessions/<sessionId>/requests/.done/      the claimed requests (claim = rename, as connectors)
 *    sessions/<sessionId>/receipts/<id>.json   out — accepted | rejected, with a reason
 *    delegation.jsonl                          one line per decision: who asked, what, the outcome
 *
 *  Identity is the DIRECTORY a request was dropped in, as on the connector channel. The role that
 *  identity carries is the one on the app's session record; what that role may do is its role
 *  file's. No environment variable is read here. That is a local trust boundary between sessions
 *  on one machine, not authentication — the same boundary connectors draw (docs/api.md). */

import * as fsSync from 'fs';
import * as path from 'path';
import { isReceiptStale, receiptFilename } from './connectors';
import type { RoleLookup } from '../core/delegation';
import {
	evaluateSessionRequest, parseSessionRequest, requesterOf,
	type FloorRepo, type FloorSession, type SessionRequest, type SpawnPlan,
} from '../core/session-requests';

export interface SpawnedInfo { terminal: string; branch: string; sessionId: string; mode?: string }

/** `spawned` on an accepted spawn; `proposalId` on an accepted propose-spawn. */
export interface SessionReceipt {
	v: 1; id: string; status: 'accepted' | 'rejected'; reason?: string; handledMs: number;
	terminalName?: string; spawned?: SpawnedInfo; proposalId?: string;
}

export interface SessionChannelDeps {
	coordDir: string;
	/** `v2.managers`, read on every request so the setting applies live. */
	enabled: () => boolean;
	/** The active role files. */
	lookup: () => RoleLookup;
	/** Every live session, overseer included, from the app's own records. */
	floor: () => FloorSession[];
	repos: () => FloorRepo[];
	spawn: (plan: SpawnPlan) => Promise<{ ok: true; spawned: SpawnedInfo } | { ok: false; reason: string }>;
	tell: (terminal: string, message: string) => Promise<{ ok: boolean; reason?: string }>;
	/** Re-parent a live session and persist it. False when it is no longer live. */
	assign: (targetSessionId: string, parentSessionId: string) => boolean;
	/** Optional extra kinds (proposals) — return null to fall through to "not handled". */
	extra?: (req: SessionRequest, requesterId: string) => Promise<Omit<SessionReceipt, 'v' | 'id' | 'handledMs'> & { log?: Record<string, unknown> } | null>;
	now?: () => number;
}

/** A session id is a uuid; anything else in sessions/ is not a session's directory. */
const SESSION_DIR = /^[A-Za-z0-9_-]{1,128}$/;

export class SessionChannel {
	private watcher: fsSync.FSWatcher | null = null;
	/** Requests are handled one at a time, in claim order: the proposal cap and an assign both read
	 *  state that the previous request may just have changed. */
	private chain: Promise<void> = Promise.resolve();

	constructor(private deps: SessionChannelDeps) {}

	private root(): string { return path.join(this.deps.coordDir, 'sessions'); }
	private now(): number { return this.deps.now?.() ?? Date.now(); }

	/** Drain what is waiting, then watch for more. Idempotent. */
	arm(): void {
		if (this.watcher) return;
		try {
			fsSync.mkdirSync(this.root(), { recursive: true });
			this.drain();
			this.watcher = fsSync.watch(this.root(), { recursive: true }, () => this.drain());
		} catch { /* channel unavailable */ }
	}

	dispose(): void { try { this.watcher?.close(); } catch { /* already closed */ } this.watcher = null; }

	/** Resolves once every request claimed so far has its receipt. For tests and shutdown. */
	idle(): Promise<void> { return this.chain; }

	/** Claim every waiting request in every session directory. Cheap when there is nothing. */
	drain(): void {
		let ids: string[] = [];
		try { ids = fsSync.readdirSync(this.root(), { withFileTypes: true }).filter((d) => d.isDirectory() && SESSION_DIR.test(d.name)).map((d) => d.name); } catch { return; }
		for (const sessionId of ids) {
			const reqDir = path.join(this.root(), sessionId, 'requests');
			let files: string[] = [];
			try { files = fsSync.readdirSync(reqDir).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
			if (files.length) { try { fsSync.mkdirSync(path.join(reqDir, '.done'), { recursive: true }); } catch { /* ignore */ } }
			for (const f of files) {
				const full = path.join(reqDir, f);
				let text = '';
				try { text = fsSync.readFileSync(full, 'utf8'); } catch { continue; }
				// Claim before acting: whichever side moves or removes the file first owns it. A sender
				// that gave up waiting withdraws its request by unlinking it, so nothing runs late.
				let claimed = false;
				try { fsSync.renameSync(full, path.join(reqDir, '.done', f)); claimed = true; } catch { try { fsSync.unlinkSync(full); claimed = true; } catch { /* withdrawn */ } }
				if (claimed) this.chain = this.chain.then(() => this.handle(sessionId, text, f.replace(/\.json$/, ''))).catch(() => { /* never break the chain */ });
			}
			this.pruneReceipts(sessionId);
		}
	}

	/** One request, start to receipt. Never throws, never stays silent while it has an id. */
	private async handle(sessionId: string, text: string, fileId: string): Promise<void> {
		const parsed = parseSessionRequest(text);
		const id = parsed.ok ? parsed.request.id : (parsed.id ?? fileId);
		const reply = (r: Omit<SessionReceipt, 'v' | 'id' | 'handledMs'>, log: Record<string, unknown> = {}): void => {
			this.writeReceipt(sessionId, { v: 1, id, handledMs: this.now(), ...r });
			this.log({ from: sessionId, kind: parsed.ok ? parsed.request.kind : 'malformed', ok: r.status === 'accepted', ...(r.reason ? { reason: r.reason } : {}), ...log });
		};
		if (!parsed.ok) { reply({ status: 'rejected', reason: parsed.reason }); return; }
		const req = parsed.request;
		try {
			if (req.kind === 'spawn' || req.kind === 'tell' || req.kind === 'assign') {
				const d = evaluateSessionRequest(req, {
					enabled: this.deps.enabled(), requesterId: sessionId,
					sessions: this.deps.floor(), lookup: this.deps.lookup(), repos: this.deps.repos(),
				});
				if (!d.ok) { reply({ status: 'rejected', reason: d.reason }, req.kind === 'spawn' ? { role: req.role, repo: req.repo } : { target: req.terminal }); return; }
				if (d.action === 'spawn') {
					const r = await this.deps.spawn(d);
					if (r.ok) reply({ status: 'accepted', terminalName: r.spawned.terminal, spawned: r.spawned }, { role: d.childRole, repo: d.repo, child: r.spawned.sessionId });
					else reply({ status: 'rejected', reason: r.reason }, { role: d.childRole, repo: d.repo });
					return;
				}
				if (d.action === 'tell') {
					const r = await this.deps.tell(d.terminal, d.message);
					reply(r.ok ? { status: 'accepted', terminalName: d.terminal } : { status: 'rejected', reason: r.reason ?? 'delivery failed' }, { target: d.terminal });
					return;
				}
				const moved = this.deps.assign(d.targetSessionId, d.parentSessionId);
				reply(moved
					? { status: 'accepted', terminalName: d.terminal }
					: { status: 'rejected', reason: `"${d.terminal}" left the floor before the assign ran` },
				{ target: d.terminal, targetSessionId: d.targetSessionId, parent: d.parentSessionId, by: requesterOf({ requesterId: sessionId, sessions: this.deps.floor() })?.name });
				return;
			}
			const r = this.deps.extra ? await this.deps.extra(req, sessionId) : null;
			if (r) { const { log, ...receipt } = r; reply(receipt, log); return; }
			reply({ status: 'rejected', reason: `${req.kind} is not handled by this build of the app` });
		} catch (e) {
			reply({ status: 'rejected', reason: `the app failed while handling it: ${(e as Error).message}` });
		}
	}

	private writeReceipt(sessionId: string, receipt: SessionReceipt): void {
		try {
			const dir = path.join(this.root(), sessionId, 'receipts');
			fsSync.mkdirSync(dir, { recursive: true });
			const fname = receiptFilename(receipt.id);
			const tmp = path.join(dir, `.${fname}.tmp`);
			fsSync.writeFileSync(tmp, JSON.stringify(receipt), 'utf8');
			fsSync.renameSync(tmp, path.join(dir, fname));
		} catch { /* best effort */ }
	}

	/** Append-only: persist() never rewrites the coordination directory, and corrections are new lines. */
	private log(entry: Record<string, unknown>): void {
		try {
			fsSync.mkdirSync(this.deps.coordDir, { recursive: true });
			fsSync.appendFileSync(path.join(this.deps.coordDir, 'delegation.jsonl'), JSON.stringify({ v: 1, ts: this.now(), ...entry }) + '\n', 'utf8');
		} catch { /* a log must not break a request */ }
	}

	/** Receipts a sender never read are pruned after a week, as the connector channel's are. */
	private pruneReceipts(sessionId: string): void {
		const dir = path.join(this.root(), sessionId, 'receipts');
		let files: string[] = [];
		try { files = fsSync.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
		const now = this.now();
		for (const f of files) {
			const full = path.join(dir, f);
			try {
				const body = JSON.parse(fsSync.readFileSync(full, 'utf8')) as { handledMs?: unknown };
				if (typeof body.handledMs === 'number' && isReceiptStale(body.handledMs, now)) fsSync.unlinkSync(full);
			} catch { /* leave it */ }
		}
	}
}
