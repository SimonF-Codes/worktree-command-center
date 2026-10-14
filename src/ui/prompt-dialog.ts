// Replaces Obsidian's TopicPromptModal — an HTML <dialog> that resolves the trimmed
// text (or null on cancel). Same contract the grid expects: Promise<string | null>.
export function promptForTopic(title: string, placeholder: string, initial = '', okLabel = 'Create'): Promise<string | null> {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog');
		dlg.style.cssText = 'background:#1a1c28;color:#e0e0e0;border:1px solid #3a3d52;border-radius:8px;padding:16px;min-width:340px;font:13px system-ui,sans-serif';

		const h = document.createElement('div');
		h.textContent = title;
		h.style.cssText = 'font-weight:600;margin-bottom:10px';

		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = placeholder;
		input.value = initial;
		input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;background:#0e0f17;color:#e0e0e0;border:1px solid #3a3d52;border-radius:4px;margin-bottom:12px';

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
		const cancel = document.createElement('button');
		cancel.textContent = 'Cancel';
		const ok = document.createElement('button');
		ok.textContent = okLabel;
		row.append(cancel, ok);

		dlg.append(h, input, row);
		document.body.appendChild(dlg);

		const done = (val: string | null): void => { dlg.close(); dlg.remove(); resolve(val); };
		cancel.addEventListener('click', () => done(null));
		ok.addEventListener('click', () => done(input.value.trim() || null));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
			else if (e.key === 'Escape') { e.preventDefault(); done(null); }
		});

		dlg.showModal();
		input.focus();
	});
}

// A vertical list of labeled choices, one button per option. Resolves the chosen id, or null
// on cancel/Escape. Matches promptForTopic's styling.
export function promptForChoice(title: string, message: string, options: { id: string; label: string; sublabel?: string }[]): Promise<string | null> {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog');
		dlg.style.cssText = 'background:#1a1c28;color:#e0e0e0;border:1px solid #3a3d52;border-radius:8px;padding:16px;min-width:340px;max-width:460px;font:13px system-ui,sans-serif';

		const h = document.createElement('div');
		h.textContent = title;
		h.style.cssText = 'font-weight:600;margin-bottom:6px';

		const msg = document.createElement('div');
		msg.textContent = message;
		msg.style.cssText = 'color:#b8bccb;margin-bottom:12px;line-height:1.45';

		const list = document.createElement('div');
		// Capped + scrolling: a list of every registered repo can run past the window.
		list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:60vh;overflow:auto';

		const done = (val: string | null): void => { dlg.close(); dlg.remove(); resolve(val); };

		for (const opt of options) {
			const btn = document.createElement('button');
			btn.style.cssText = 'text-align:left;padding:8px 10px;background:#0e0f17;color:#e0e0e0;border:1px solid #3a3d52;border-radius:4px;cursor:pointer';
			btn.textContent = opt.label;
			if (opt.sublabel) {
				const sub = document.createElement('div');
				sub.textContent = opt.sublabel;
				sub.style.cssText = 'color:#7a7f96;font-size:11px;margin-top:2px';
				btn.appendChild(sub);
			}
			btn.addEventListener('click', () => done(opt.id));
			list.appendChild(btn);
		}

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;justify-content:flex-end';
		const cancel = document.createElement('button');
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => done(null));
		row.append(cancel);

		dlg.append(h, msg, list, row);
		document.body.appendChild(dlg);

		dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); }); // native Esc
		dlg.showModal();
	});
}

// A yes/no confirm dialog matching promptForTopic's styling. Resolves true on confirm,
// false on cancel/Escape. The OK button is styled destructive (red).
export function promptForConfirm(title: string, message: string, okLabel = 'Confirm'): Promise<boolean> {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog');
		dlg.style.cssText = 'background:#1a1c28;color:#e0e0e0;border:1px solid #3a3d52;border-radius:8px;padding:16px;min-width:340px;max-width:460px;font:13px system-ui,sans-serif';

		const h = document.createElement('div');
		h.textContent = title;
		h.style.cssText = 'font-weight:600;margin-bottom:10px';

		const msg = document.createElement('div');
		msg.textContent = message;
		// pre-wrap so a confirm can LIST what it is about to act on, one per line: a confirm that
		// says "close 7 sessions" without naming them is not something anyone can agree to
		// honestly. The cap + overflow keep a long list (a tab close, or a bulk idle close) on
		// screen instead of running off the bottom. Single-line callers are unaffected.
		msg.style.cssText = 'color:#b8bccb;margin-bottom:14px;line-height:1.45;white-space:pre-wrap;max-height:50vh;overflow:auto';

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
		const cancel = document.createElement('button');
		cancel.textContent = 'Cancel';
		const ok = document.createElement('button');
		ok.textContent = okLabel;
		ok.style.cssText = 'background:#d2453e;color:#fff;border:1px solid #d2453e;border-radius:4px;padding:4px 12px;cursor:pointer';
		row.append(cancel, ok);

		dlg.append(h, msg, row);
		document.body.appendChild(dlg);

		const done = (val: boolean): void => { dlg.close(); dlg.remove(); resolve(val); };
		cancel.addEventListener('click', () => done(false));
		ok.addEventListener('click', () => done(true));
		dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); }); // native Esc
		dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } });

		dlg.showModal();
		ok.focus();
	});
}
