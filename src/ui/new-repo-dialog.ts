import { GITIGNORE_KINDS, newRepoProblem, type NewRepoParams, type GitignoreKind, type RemoteChoice } from '../new-repo-params';

export interface NewRepoDialogOpts {
	initial: NewRepoParams;
	/** Whether the GitHub CLI was found. Without it the remote choice is shown but disabled, with
	 *  the reason, so its absence reads as "not available here" rather than "not a feature". */
	ghAvailable: boolean;
	/** The native folder picker (with its New Folder button). */
	chooseFolder: () => Promise<string | null>;
	/** Shown above the buttons on open — used when a previous attempt failed and the form is
	 *  re-offered with everything the person typed still in it. */
	error?: string;
}

/** The form behind "🆕 New repo…": name, location, and the initial parameters (see
 *  new-repo-params.ts for why each one is there). Resolves the params, or null on cancel.
 *  Styled like the other prompt dialogs. Validation is newRepoProblem — the same rule the caller
 *  relies on — so Create cannot hand back something createGitRepo will refuse. */
export function promptForNewRepo(opts: NewRepoDialogOpts): Promise<NewRepoParams | null> {
	return new Promise((resolve) => {
		const p: NewRepoParams = { ...opts.initial };
		const field = 'width:100%;box-sizing:border-box;padding:6px 8px;background:#0e0f17;color:#e0e0e0;border:1px solid #3a3d52;border-radius:4px';
		const dlg = document.createElement('dialog');
		dlg.style.cssText = 'background:#1a1c28;color:#e0e0e0;border:1px solid #3a3d52;border-radius:8px;padding:16px;min-width:420px;max-width:520px;font:13px system-ui,sans-serif';

		const h = document.createElement('div');
		h.textContent = 'New git repository';
		h.style.cssText = 'font-weight:600;margin-bottom:12px';
		dlg.append(h);

		const row = (label: string, control: HTMLElement, hint?: string): void => {
			const wrap = document.createElement('label');
			wrap.style.cssText = 'display:block;margin-bottom:10px';
			const l = document.createElement('div');
			l.textContent = label;
			l.style.cssText = 'color:#b8bccb;margin-bottom:4px';
			wrap.append(l, control);
			if (hint) {
				const s = document.createElement('div');
				s.textContent = hint;
				s.style.cssText = 'color:#7a7f96;font-size:11px;margin-top:3px';
				wrap.append(s);
			}
			dlg.append(wrap);
		};

		const name = document.createElement('input');
		name.type = 'text';
		name.placeholder = 'my-project';
		name.value = p.name;
		name.style.cssText = field;
		row('Name', name);

		const locRow = document.createElement('div');
		locRow.style.cssText = 'display:flex;gap:6px';
		const loc = document.createElement('input');
		loc.type = 'text';
		loc.placeholder = 'Choose a folder…';
		loc.value = p.parentDir;
		loc.style.cssText = field;
		const browse = document.createElement('button');
		browse.type = 'button';
		browse.textContent = 'Browse…';
		locRow.append(loc, browse);
		row('Create inside', locRow, 'A new folder named after the repo is made here. It must not already exist.');

		const branch = document.createElement('input');
		branch.type = 'text';
		branch.value = p.branch;
		branch.style.cssText = field;
		row('Base branch', branch, 'Every terminal’s worktree is cut from this branch.');

		const gi = document.createElement('select');
		gi.style.cssText = field;
		for (const k of GITIGNORE_KINDS) {
			const o = document.createElement('option');
			o.value = k.id; o.textContent = k.label;
			gi.append(o);
		}
		gi.value = p.gitignore;
		row('.gitignore', gi);

		const cmWrap = document.createElement('div');
		const cm = document.createElement('input');
		cm.type = 'checkbox';
		cm.checked = p.claudeMd;
		const cmText = document.createElement('span');
		cmText.textContent = ' Seed a CLAUDE.md for the sessions that will work here';
		cmWrap.append(cm, cmText);
		row('CLAUDE.md', cmWrap);

		const remote = document.createElement('select');
		remote.style.cssText = field;
		for (const [id, label] of [['none', 'None — local only'], ['private', 'Private GitHub repo'], ['public', 'Public GitHub repo']] as const) {
			const o = document.createElement('option');
			o.value = id; o.textContent = label;
			remote.append(o);
		}
		remote.value = opts.ghAvailable ? p.remote : 'none';
		remote.disabled = !opts.ghAvailable;
		row('Remote', remote, opts.ghAvailable
			? 'Uses gh: creates the GitHub repo, adds it as origin, pushes the first commit.'
			: 'GitHub CLI (gh) not found on PATH or in winget’s folder — install it to create a remote here.');

		const err = document.createElement('div');
		err.style.cssText = 'color:#ff8a80;min-height:16px;margin:4px 0 10px;white-space:pre-wrap';
		err.textContent = opts.error ?? '';
		dlg.append(err);

		const buttons = document.createElement('div');
		buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
		const cancel = document.createElement('button');
		cancel.textContent = 'Cancel';
		const ok = document.createElement('button');
		ok.textContent = 'Create…';
		buttons.append(cancel, ok);
		dlg.append(buttons);
		document.body.appendChild(dlg);

		const read = (): NewRepoParams => ({
			name: name.value.trim(),
			parentDir: loc.value.trim(),
			branch: branch.value.trim(),
			gitignore: gi.value as GitignoreKind,
			claudeMd: cm.checked,
			remote: remote.value as RemoteChoice,
		});
		const done = (val: NewRepoParams | null): void => { dlg.close(); dlg.remove(); resolve(val); };
		const submit = (): void => {
			const v = read();
			const problem = newRepoProblem(v, opts.ghAvailable);
			if (problem) { err.textContent = problem; return; }
			done(v);
		};
		browse.addEventListener('click', () => {
			void opts.chooseFolder().then((f) => { if (f) loc.value = f; });
		});
		cancel.addEventListener('click', () => done(null));
		ok.addEventListener('click', submit);
		dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); }); // native Esc
		dlg.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); submit(); }
		});

		dlg.showModal();
		name.focus();
	});
}
