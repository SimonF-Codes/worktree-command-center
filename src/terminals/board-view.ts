import * as fs from 'fs';
import * as path from 'path';
import { parseBoardLine, lockStatus, mergeEvents, isEvent, POLL_MS, type BoardEvent, type RawLine, type LockHolder } from './coordination';

/** A background Task/Agent run derived from board.md: a `task:<tileId>:<taskId>` resource
 *  whose latest event is still START (no matching DONE has landed yet). */
interface BgTask { tileId: number; terminal: string; label: string; startTs: number }

function fmtAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

const COORD_COLLAPSE_KEY = 'cos-coord-collapsed';

/** Whether the Coordination panel should start collapsed, given the persisted preference.
 *  Default (nothing stored) = collapsed, so it never pops open on a workspace switch; only an
 *  explicit '0' (the user expanded it) keeps it open. */
export function coordBoardStartsCollapsed(stored: string | null): boolean {
	return stored !== '0';
}

/** A collapsible panel showing the group's active locks + recent board feed, polled live. */
export class BoardView {
	private el: HTMLElement | null = null;
	private registryEl: HTMLElement | null = null;
	private locksEl: HTMLElement | null = null;
	private feedEl: HTMLElement | null = null;
	private hiddenEl: HTMLElement | null = null;
	private bgEl: HTMLElement | null = null;
	private timer: number | null = null;

	constructor(
		private coordDir: string,
		private onReopen: (branch: string) => void = () => {},
		private hiddenProvider: () => Array<{ tileId: number; name: string; branch: string; repo: string }> = () => [],
		private onShow: (tileId: number) => void = () => {},
		private onClose: (tileId: number) => void = () => {},
		private onFocusTile: (tileId: number) => void = () => {},
		private onArchive: (branch: string) => void = () => {},
	) {}

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-coord-board' });
		// Start as the user last left it (collapsed by default). mount() runs on every workspace
		// switch, which otherwise re-created the panel with no 'collapsed' class → it popped open
		// every time. Persist the toggle so the choice sticks across switches.
		let stored: string | null = null;
		try { stored = window.localStorage.getItem(COORD_COLLAPSE_KEY); } catch { /* no storage */ }
		if (coordBoardStartsCollapsed(stored)) this.el.classList.add('collapsed');
		const head = this.el.createDiv({ cls: 'cos-coord-head', text: '🛰 Coordination' });
		head.addEventListener('click', () => {
			const collapse = !this.el!.classList.contains('collapsed');
			this.el?.toggleClass('collapsed', collapse);
			try { window.localStorage.setItem(COORD_COLLAPSE_KEY, collapse ? '1' : '0'); } catch { /* no storage */ }
		});
		this.hiddenEl = this.el.createDiv({ cls: 'cos-coord-hidden' });
		this.registryEl = this.el.createDiv({ cls: 'cos-coord-registry' });
		this.bgEl = this.el.createDiv({ cls: 'cos-coord-bg' });
		this.locksEl = this.el.createDiv({ cls: 'cos-coord-locks' });
		this.feedEl = this.el.createDiv({ cls: 'cos-coord-feed' });
		this.renderAll();
		this.timer = window.setInterval(() => this.renderAll(), POLL_MS);
	}

	unmount(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		this.el?.remove();
		this.el = this.registryEl = this.locksEl = this.feedEl = this.hiddenEl = this.bgEl = null;
	}

	/** Re-read worktrees.md + board.md and re-render everything. */
	public refresh(): void {
		this.renderAll();
	}

	private readRegistry(): string[] {
		try { return fs.readFileSync(path.join(this.coordDir, 'worktrees.md'), 'utf8').split('\n'); } catch { return []; }
	}

	private readLocks(): LockHolder[] {
		const dir = path.join(this.coordDir, 'locks');
		let names: string[] = [];
		try { names = fs.readdirSync(dir); } catch { return []; }
		const out: LockHolder[] = [];
		for (const n of names) {
			if (!n.endsWith('.json')) continue;
			try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as LockHolder); } catch { /* skip */ }
		}
		return out;
	}

	private readFeed(): Array<BoardEvent | RawLine> {
		let text = '';
		try { text = fs.readFileSync(path.join(this.coordDir, 'board.md'), 'utf8'); } catch { return []; }
		const parsed = text.split('\n').map(parseBoardLine).filter((x): x is BoardEvent | RawLine => x !== null);
		return mergeEvents(parsed as Array<{ ts?: number }>).slice(0, 50) as Array<BoardEvent | RawLine>;
	}

	/** From the feed, the `task:<tileId>:<taskId>` resources whose latest event is still START —
	 *  i.e. background Task/Agent runs with no DONE yet. */
	private runningTasks(feed: Array<BoardEvent | RawLine>): BgTask[] {
		const latest = new Map<string, BoardEvent>();
		for (const e of feed) {
			if (!isEvent(e) || !e.resource.startsWith('task:')) continue;
			const prev = latest.get(e.resource);
			if (!prev || e.ts > prev.ts) latest.set(e.resource, e);
		}
		const out: BgTask[] = [];
		for (const [resource, e] of latest) {
			if (e.status !== 'START') continue;
			const tileId = Number(resource.split(':')[1]);
			if (!Number.isFinite(tileId)) continue;
			out.push({ tileId, terminal: e.terminal, label: e.detail || 'task', startTs: e.ts });
		}
		return out.sort((a, b) => a.startTs - b.startTs);
	}

	private renderAll(): void {
		if (!this.registryEl || !this.locksEl || !this.feedEl || !this.hiddenEl || !this.bgEl) return;
		const now = Date.now();
		const feed = this.readFeed();

		// Hidden-terminals section (in-memory, provided by the grid). Resurface with Show.
		this.hiddenEl.empty();
		const hiddenList = this.hiddenProvider();
		if (hiddenList.length) {
			this.hiddenEl.createDiv({ cls: 'cos-reg-repo', text: 'Hidden' });
			for (const h of hiddenList) {
				const row = this.hiddenEl.createDiv({ cls: 'cos-reg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: h.name });
				if (h.repo) row.createSpan({ cls: 'cos-reg-repo-tag', text: h.repo });
				if (h.branch && h.branch !== h.name) row.createSpan({ cls: 'cos-reg-detail', text: h.branch });
				const btn = row.createEl('button', { text: 'Show', cls: 'cos-reopen-btn' });
				btn.addEventListener('click', (e) => { e.stopPropagation(); this.onShow(h.tileId); });
				const x = row.createEl('button', { text: '✕', cls: 'cos-close-btn', attr: { title: 'Close — removes the worktree + branch' } });
				x.addEventListener('click', (e) => { e.stopPropagation(); this.onClose(h.tileId); });
			}
		}

		// Registry section (worktrees.md) — parse the markdown into clean styled rows
		// (a repo heading per `## repo`, a row per `- <branch> <badge> …`), not raw text.
		this.registryEl.empty();
		for (const raw of this.readRegistry()) {
			const t = raw.trim();
			if (!t || t === '# Worktrees') continue;            // skip the H1 (the panel head covers it)
			if (t.startsWith('## ')) {                           // repo heading
				this.registryEl.createDiv({ cls: 'cos-reg-repo', text: t.slice(3) });
				continue;
			}
			if (t.startsWith('_')) {                             // _No active worktrees._
				this.registryEl.createSpan({ cls: 'cos-coord-empty', text: t.replace(/_/g, '') });
				continue;
			}
			if (t.startsWith('- ')) {                            // a worktree row
				const body = t.slice(2);
				const branch = (body.match(/^(\S+)/)?.[1]) ?? body;
				const state = body.includes('[DIRTY]') ? 'dirty'
					: body.includes('[PARKED]') ? 'parked'
					: body.includes('[ahead]') ? 'ahead' : 'clean';
				const detail = body.slice(branch.length).trim()
					.replace(/^\[(DIRTY|PARKED|ahead)\]\s*/i, '')
					.replace(/^clean\s*/, '')
					.replace(/^·\s*/, '')
					.trim();
				const row = this.registryEl.createDiv({ cls: 'cos-reg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: branch });
				row.createSpan({ cls: `cos-reg-badge ${state}`, text: state });
				if (detail) row.createSpan({ cls: 'cos-reg-detail', text: detail });
				if (state === 'parked') {
					const btn = row.createEl('button', { text: 'Reopen', cls: 'cos-reopen-btn' });
					btn.addEventListener('click', (e) => { e.stopPropagation(); this.onReopen(branch); });
				}
				// Archive is offered on EVERY worktree, in any state — archiving parks dirty work and
				// keeps the branch, so there's nothing a given state makes unsafe. The grid re-checks
				// that no terminal owns it and confirms before anything is deleted.
				const arch = row.createEl('button', { text: '🗄', cls: 'cos-archive-btn', attr: { title: `Archive ${branch} — zip its files + conversation, then delete the folder` } });
				arch.addEventListener('click', (e) => { e.stopPropagation(); this.onArchive(branch); });
			}
		}

		// Background tasks section — running Task/Agent calls across every terminal, click to
		// jump straight to the tile running one (same "reveal" affordance as Hidden → Show).
		this.bgEl.empty();
		const running = this.runningTasks(feed);
		if (running.length) {
			this.bgEl.createDiv({ cls: 'cos-reg-repo', text: 'Background tasks' });
			for (const t of running) {
				const row = this.bgEl.createDiv({ cls: 'cos-reg-row cos-bg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: `⏳ ${t.terminal}` });
				row.createSpan({ cls: 'cos-reg-detail', text: `${t.label} · running ${fmtAge(now - t.startTs)}` });
				row.addEventListener('click', () => this.onFocusTile(t.tileId));
			}
		}

		// Locks section.
		const locks = this.readLocks();
		this.locksEl.empty();
		if (!locks.length) {
			this.locksEl.createSpan({ cls: 'cos-coord-empty', text: 'no active locks' });
		}
		for (const l of locks) {
			const st = lockStatus(l, now);
			const age = Math.max(0, Math.round((now - l.ts) / 1000));
			const badge = this.locksEl.createSpan({ cls: `cos-coord-lock ${st}` });
			badge.setText(`🔒 ${l.resource} · ${l.holder}${l.reason ? ` · ${l.reason}` : ''} · ${age < 90 ? age + 's' : Math.round(age / 60) + 'm'}`);
		}

		// Event log feed.
		this.feedEl.empty();
		for (const e of feed) {
			const row = this.feedEl.createDiv({ cls: 'cos-coord-row' });
			if (isEvent(e)) row.setText(`${e.terminal} · ${e.resource} ${e.status}${e.detail ? ' · ' + e.detail : ''}`);
			else row.setText(e.raw);
		}
	}
}
