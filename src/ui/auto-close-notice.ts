import type { AutoCloseNotice } from '../terminals/auto-closer';
import type { NoticeView } from '../terminals/auto-close';

/** The auto-close warning, on screen.
 *
 *  Its own element rather than a toast, deliberately. A toast can wait behind three others in
 *  the "+N more" queue, expires on its own clock and is dismissed by any click on its body — a
 *  warning whose whole job is to be SEEN before sessions close can afford none of that. This
 *  one is always drawn, stands until the closer takes it down, and only its two buttons act.
 *
 *  Just the renderer: every decision — who is named, what is dropped, when to close — is the
 *  AutoCloser's, and tested there. */
export class AutoCloseNoticeView implements AutoCloseNotice {
	private el: HTMLElement | null = null;
	private ticker: number | null = null;

	warn(view: NoticeView, deadline: number, actions: { keep: () => void; closeNow: () => void }): void {
		const el = this.draw(view, 'wcc-autoclose-warn');
		const row = el.createDiv({ cls: 'wcc-autoclose-actions' });
		const keep = row.createEl('button', { cls: 'wcc-autoclose-keep', text: 'Keep them' });
		keep.addEventListener('click', (e) => { e.stopPropagation(); actions.keep(); });
		const now = row.createEl('button', { cls: 'wcc-autoclose-now' });
		now.addEventListener('click', (e) => { e.stopPropagation(); now.disabled = true; actions.closeNow(); });
		const paint = (): void => {
			const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
			now.textContent = `Close now (${secs}s)`;
		};
		paint();
		this.stopTicker();
		this.ticker = window.setInterval(paint, 500);
	}

	result(view: NoticeView): void {
		this.stopTicker();
		const el = this.draw(view, 'wcc-autoclose-result');
		const row = el.createDiv({ cls: 'wcc-autoclose-actions' });
		const ok = row.createEl('button', { cls: 'wcc-autoclose-keep', text: 'Dismiss' });
		ok.addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
	}

	hide(): void {
		this.stopTicker();
		this.el?.remove();
		this.el = null;
	}

	private draw(view: NoticeView, cls: string): HTMLElement {
		this.el?.remove();
		const el = document.body.createDiv({ cls: `wcc-autoclose ${cls}` });
		el.setAttribute('role', 'alert');
		el.createDiv({ cls: 'wcc-autoclose-title', text: view.title });
		if (view.lines.length) {
			const list = el.createEl('ul', { cls: 'wcc-autoclose-list' });
			for (const l of view.lines) list.createEl('li', { text: l });
		}
		el.createDiv({ cls: 'wcc-autoclose-detail', text: view.detail });
		this.el = el;
		return el;
	}

	private stopTicker(): void {
		if (this.ticker !== null) { window.clearInterval(this.ticker); this.ticker = null; }
	}
}
