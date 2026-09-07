import { isChatPost, CHAT_POLL_MS, type ChatRaw } from './coordination';
import { ChatRoom } from './chat-room';
import { InputHistory } from './input-history';

/** A stage tile rendered as an iMessage-style group chat. The bottom box always
 *  broadcasts to the room. When an agent needs input (e.g. a bash-command approval),
 *  it appears as an input-request CARD inside the chat with Approve / Deny / reply —
 *  answered right here, never in the terminal. Multiple requests show at once. */
export class ChatTile {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;
	private input: HTMLInputElement | null = null;
	private pauseBtn: HTMLButtonElement | null = null;
	private timer: number | null = null;
	private lastSig = ''; // skip body rebuilds when nothing changed (so typing in a card reply isn't wiped)
	private history = new InputHistory(); // Up/Down recalls messages you've sent to the room

	constructor(public readonly tileId: number, private room: ChatRoom, private onClose: () => void, private onCenter: () => void = () => {}) {}

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-chat-tile' });
		this.el.addEventListener('click', () => this.onCenter()); // click centers it, like a terminal tile
		const head = this.el.createDiv({ cls: 'cos-chat-head' });
		head.createSpan({ text: `💬 ${this.room.memberNames.join(', ')}` });
		this.pauseBtn = head.createEl('button', { text: '⏸ Pause' });
		this.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); this.room.setPaused(!this.room.isPaused); this.refresh(); });
		const close = head.createEl('button', { text: '×' });
		close.addEventListener('click', (e) => { e.stopPropagation(); this.onClose(); });

		this.bannerEl = this.el.createDiv({ cls: 'cos-chat-banner' });
		this.bodyEl = this.el.createDiv({ cls: 'cos-chat-body' });
		const inputWrap = this.el.createDiv({ cls: 'cos-chat-inputrow' });
		this.input = inputWrap.createEl('input', { attr: { type: 'text', placeholder: 'message the room…' } });
		this.input.addEventListener('keydown', (e) => {
			// Up/Down recall previously sent messages so you can edit-and-resend, like a shell.
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				const next = e.key === 'ArrowUp' ? this.history.up(this.input!.value) : this.history.down();
				if (next === null) return; // nothing to recall — leave the caret alone
				e.preventDefault();
				this.setInputValue(next);
				return;
			}
			if (e.key !== 'Enter') return;
			e.preventDefault();
			const v = this.input!.value.trim();
			this.input!.value = '';
			if (v) { this.history.record(v); this.room.broadcast(v); } // the box ALWAYS broadcasts; input requests are answered in the cards
		});

		this.room.setOnChange(() => this.refresh());
		this.room.start();
		this.lastSig = '';
		this.refresh();
		this.timer = window.setInterval(() => this.refresh(), CHAT_POLL_MS);
	}

	private refresh(): void {
		if (!this.bodyEl || !this.bannerEl || !this.input || !this.pauseBtn) return;
		this.pauseBtn.setText(this.room.isPaused ? '▶ Resume' : '⏸ Pause');
		const waiting = this.room.waitingList();

		this.bannerEl.empty();
		if (waiting.length) {
			this.bannerEl.createSpan({ text: `⏳ ${waiting.length} input request${waiting.length > 1 ? 's' : ''} need you — approve or reply below` });
			this.el?.addClass('paused');
		} else {
			this.el?.removeClass('paused');
		}

		// Only rebuild the body when the transcript or the waiting set changed, so typing
		// in a card's reply box isn't wiped by the 1s refresh.
		const transcript = this.room.transcript();
		const sig = `${transcript.length}|${waiting.join(',')}`;
		if (sig === this.lastSig) return;

		// Preserve a focused card reply across the rebuild.
		const active = document.activeElement as HTMLInputElement | null;
		const keepAgent = active && active.classList.contains('cos-req-reply') ? active.dataset.agent : undefined;
		const keepVal = active?.value;
		const keepSel = active?.selectionStart ?? null;
		this.lastSig = sig;

		this.bodyEl.empty();
		for (const e of transcript) {
			const row = this.bodyEl.createDiv({ cls: 'cos-chat-msg' });
			if (isChatPost(e)) {
				if (e.terminal === 'you') { row.addClass('me'); }
				else if (e.terminal === '→') { row.addClass('muted'); }
				else { row.addClass('them'); row.createDiv({ cls: 'cos-chat-who', text: e.terminal }); }
				row.createDiv({ cls: 'cos-chat-text', text: e.message });
			} else {
				row.addClass('muted');
				row.setText((e as ChatRaw).raw);
			}
		}

		// One input-request card per waiting agent — answer them all here.
		for (const name of waiting) {
			const card = this.bodyEl.createDiv({ cls: 'cos-chat-req' });
			card.addEventListener('click', (e) => e.stopPropagation()); // don't bubble to the center-on-click
			card.createDiv({ cls: 'cos-chat-req-title', text: `⏳ ${name} wants your input` });
			const pr = this.room.promptFor(name);
			if (pr) card.createEl('pre', { cls: 'cos-chat-req-pre', text: pr });
			const rowEl = card.createDiv({ cls: 'cos-chat-req-row' });
			rowEl.createEl('button', { cls: 'cos-req-approve', text: '✓ Approve' })
				.addEventListener('click', (e) => { e.stopPropagation(); this.room.respond(name, '\r', 'approved →'); });
			rowEl.createEl('button', { cls: 'cos-req-deny', text: '✗ Deny' })
				.addEventListener('click', (e) => { e.stopPropagation(); this.room.respond(name, '\x1b', 'denied →'); });
			const reply = rowEl.createEl('input', { cls: 'cos-req-reply', attr: { type: 'text', placeholder: `reply to ${name}…` } });
			reply.dataset.agent = name;
			reply.addEventListener('keydown', (e) => {
				if (e.key !== 'Enter') return;
				e.preventDefault();
				const v = reply.value.trim();
				if (v) this.room.respond(name, `${v}\r`, `replied "${v}" →`);
			});
		}
		this.bodyEl.scrollTop = this.bodyEl.scrollHeight;

		if (keepAgent) {
			const inputs = Array.from(this.bodyEl.querySelectorAll('input.cos-req-reply')) as HTMLInputElement[];
			const inp = inputs.find((i) => i.dataset.agent === keepAgent);
			if (inp) { inp.value = keepVal ?? ''; inp.focus(); if (keepSel !== null) { try { inp.setSelectionRange(keepSel, keepSel); } catch { /* ignore */ } } }
		}
	}

	setRect(r: { x: number; y: number; w: number; h: number }): void {
		if (!this.el) return;
		this.el.style.left = `${r.x}px`;
		this.el.style.top = `${r.y}px`;
		this.el.style.width = `${r.w}px`;
		this.el.style.height = `${r.h}px`;
	}

	/** Replace the message box's text and park the caret at the end — so a recalled message
	 *  is ready to edit or resend, not selected or with the caret mid-string. */
	private setInputValue(v: string): void {
		if (!this.input) return;
		this.input.value = v;
		const end = v.length;
		try { this.input.setSelectionRange(end, end); } catch { /* older engines — value is still set */ }
	}

	setCentered(on: boolean): void { this.el?.toggleClass('centered', on); }
	focus(): void { this.input?.focus(); }

	unmount(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		this.room.dispose();
		this.el?.remove();
		this.el = this.bodyEl = this.bannerEl = null;
		this.input = null;
		this.pauseBtn = null;
	}
}
