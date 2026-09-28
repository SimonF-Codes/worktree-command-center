import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { activeTerminalPalette, activeTerminalFont, type TerminalPalette } from './theme-store';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge, safeSessionEnv } from './session-bridge';
import { readClipboardText, writeClipboardText } from './clipboard';
import { godSystemPrompt, type GodRepo, type GodSelfImprove } from './god';
import { loadRolePrompt } from './role-loader';
import type { SessionFact } from './role-library';
import { scrollIntentForKey, type ScrollIntent } from './scroll-keys';
import { FitThrottle } from './fit-throttle';
import { ctrlClickActivator, openExternalUrl } from './links';
import { promptForConfirm } from '../ui/prompt-dialog';
import { NoticeGate } from './notice-gate';
import { shouldStartFresh } from './resume-fallback';
import { orphanTranscripts, pickResumeFile, projectDirName, type JobRecord } from './resume-target';

/** How long a released backlog waits before being typed in, so the keystroke that emptied the box
 *  lands first. Nothing to do with the 250/900ms Enter pair in writeNotice. */
const FLUSH_SETTLE_MS = 250;

export interface GodConsoleOpts {
	repos: GodRepo[];
	coordDir: string;
	sidecarPath: string;
	godHomeDir: string;   // a neutral cwd outside every repo
	sessionEnv?: () => Record<string, string>;
	selfImprove?: GodSelfImprove; // when set, Kane may improve his own source + build tools
	/** config.json's `roleLibrary.path` — the vault folder holding the agents' role files.
	 *  Undefined (the default) means this console uses the compiled-in godSystemPrompt. */
	roleLibraryPath?: string;
	onFocusChange?: (focused: boolean) => void;
	instanceName?: string;   // head label + COS_TERMINAL_NAME (default 'Kane')
	terminalId?: string;     // COS_TERMINAL_ID for cos-coord identity (default '0')
	resume?: boolean;        // reopen this home's conversation (fresh fallback) — the main Kane sets this
	/** Fired once if this console's claude reports transcript saving is off (see TerminalTile's). */
	onTranscriptOff?: () => void;
}

/** GOD: a single privileged claude session in a docked side panel. Real terminal — the
 *  user types directly into it. Hidden (not killed) when toggled off, so re-opening is
 *  instant. No worktree, no branch, no delete-on-close. */
export class GodConsole {
	private el: HTMLElement | null = null;
	private nameSpan: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private fit: FitAddon | null = null;
	private bridge: SessionBridge | null = null;
	private resizeObs: ResizeObserver | null = null;
	private fitThrottle: FitThrottle | null = null;
	private busy = false;            // approximate: true while output is actively streaming
	private busyTimer: number | null = null;
	private queueEl: HTMLElement | null = null;
	private readyWatcher: fs.FSWatcher | null = null;
	private pasting = false;         // true only while term.paste() is feeding onData (never a submit)
	/** Holds notifications back while the user is mid-sentence in this console, and releases them
	 *  when the input box goes empty — see notice-gate.ts. Before this, notify() typed straight
	 *  into the PTY and pressed Enter, merging the notice with whatever was already in the box. */
	private gate = new NoticeGate({
		deliver: (text, kind) => {
			if (kind === 'immediate') { this.writeNotice(text); return; }
			// A release is triggered BY the user's own keystroke (their Enter / Ctrl+U), which we
			// have just forwarded. Let it reach the TUI first: ConPTY would otherwise coalesce the
			// two writes into one chunk and the TUI would read their Enter as a pasted newline —
			// the same hazard sendLine's 250ms comment describes. This delays the TEXT, not the
			// Enter timing below, which is unchanged.
			window.setTimeout(() => this.writeNotice(text), FLUSH_SETTLE_MS);
		},
		onQueueChange: (n) => this.renderQueueBadge(n),
	});

	constructor(private opts: GodConsoleOpts, private onHide: () => void) {}

	/** The panel root, so the grid can place it in the dock and toggle visibility. */
	get element(): HTMLElement | null { return this.el; }

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-god-panel' });
		// Report keyboard-focus changes so the grid can hold auto-centering while the user is
		// typing to Kane (mirrors terminal-tile's focusin/focusout wiring).
		this.el.addEventListener('focusin', () => this.opts.onFocusChange?.(true));
		this.el.addEventListener('focusout', () => this.opts.onFocusChange?.(false));
		// Left-edge grip: drag to resize the panel width. One shared width for every Kane
		// panel, persisted across sessions; the body's ResizeObserver refits xterm live.
		const saved = Number(window.localStorage.getItem('cos-god-width'));
		// `0 1`, matching the stylesheet: the dragged width is what this panel ASKS for, not a
		// floor it holds against the window. Inline `0 0` here used to override the rule and put
		// the panels back to overflowing the dock row whenever more than one was docked.
		if (Number.isFinite(saved) && saved >= 280) this.el.style.flex = `0 1 ${Math.min(Math.round(saved), Math.round(window.innerWidth * 0.7))}px`;
		const grip = this.el.createDiv({ cls: 'cos-god-resize' });
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = this.el?.getBoundingClientRect().width ?? 0;
			grip.setPointerCapture(e.pointerId); // pointerup arrives even if released outside the window
			grip.classList.add('dragging');
			const move = (ev: PointerEvent): void => {
				if (!this.el) return; // disposed mid-drag
				const w = Math.min(Math.max(280, startW + (startX - ev.clientX)), Math.round(window.innerWidth * 0.7));
				this.el.style.flex = `0 1 ${Math.round(w)}px`;
			};
			const up = (ev: PointerEvent): void => {
				grip.classList.remove('dragging');
				grip.removeEventListener('pointermove', move);
				grip.removeEventListener('pointerup', up);
				grip.removeEventListener('pointercancel', up);
				try { grip.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
				if (this.el) window.localStorage.setItem('cos-god-width', String(Math.round(this.el.getBoundingClientRect().width)));
			};
			grip.addEventListener('pointermove', move);
			grip.addEventListener('pointerup', up);
			grip.addEventListener('pointercancel', up);
		});
		const head = this.el.createDiv({ cls: 'cos-god-head' });
		this.nameSpan = head.createSpan({ text: `🜲 ${this.opts.instanceName ?? 'Kane'}` });
		// Out-of-band queue badge: while notices are held back, SAY so somewhere other than the
		// terminal. A notice that silently never arrives is indistinguishable from no notice at
		// all — that exact failure shipped here once already, in the fresh-session fallback.
		this.queueEl = head.createSpan({ cls: 'cos-notice-queue' });
		this.queueEl.style.display = 'none';
		this.queueEl.addEventListener('click', (e) => { e.stopPropagation(); this.gate.flushNow(); });
		const refreshBtn = head.createEl('button', { text: '⟳', cls: 'cos-term-refresh', attr: { title: 'Refresh Kane — reload with --continue (keeps the conversation)' } });
		refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.refresh(); });
		const hide = head.createEl('button', { text: '×', attr: { title: 'Hide Kane (session keeps running)' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.onHide(); });

		this.bodyEl = this.el.createDiv({ cls: 'cos-god-body' });
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: false, scrollback: 5000, theme: activeTerminalPalette(), ...activeTerminalFont(),
			// OSC 8 hyperlinks from the new Claude TUI — open in the real browser on Ctrl/Cmd+click
			// instead of xterm's built-in "navigate… could be dangerous" confirm (no linkHandler set).
			linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) openExternalUrl(uri); } },
		});
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		this.term.open(this.bodyEl);
		// GPU-accelerated rendering, mirroring TerminalTile: load after open(); on context
		// loss dispose → xterm falls back to the DOM renderer for this console only.
		try {
			const gl = new WebglAddon();
			gl.onContextLoss(() => gl.dispose());
			this.term.loadAddon(gl);
		} catch { /* no GPU/context available — DOM renderer remains */ }
		// Ctrl/Cmd+click a URL to open it in the real browser.
		this.term.loadAddon(new WebLinksAddon(ctrlClickActivator(openExternalUrl)));
		// Clipboard + scrollback keys, mirroring TerminalTile: Ctrl/Cmd+V pastes (xterm would
		// otherwise send a literal ^V to Claude); Shift+Page/Arrow/Home/End scroll. Everything
		// else passes through to Claude untouched.
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
				e.preventDefault(); // suppress the browser's own paste so we don't double-paste
				this.pasteFromClipboard();
				return false;
			}
			// Copy: Ctrl/Cmd+Shift+C always copies the selection; plain Ctrl/Cmd+C copies ONLY
			// when there is a selection — otherwise it must fall through to Claude as the
			// interrupt (SIGINT), which is what Ctrl+C means in a terminal.
			if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
				const hasSel = !!this.term?.hasSelection();
				if (e.shiftKey || hasSel) {
					if (hasSel) {
						const sel = this.term!.getSelection();
						if (sel) this.writeClipboard(sel);
						this.term!.clearSelection();
					}
					e.preventDefault();
					return false;
				}
				return true; // no selection → let plain Ctrl+C through as interrupt
			}
			const intent = scrollIntentForKey(e);
			if (!intent) return true;
			// New flicker-free TUI keeps the conversation in the ALTERNATE screen buffer (no xterm
			// scrollback) — translate Shift+nav into Claude's native scroll keys down the PTY. The
			// classic normal-buffer TUI still has scrollback, so scroll xterm there.
			if (this.term?.buffer.active.type === 'alternate') { this.sendScrollKey(intent); return false; }
			this.applyScroll(intent);
			return false;
		});
		// Right-click: copy the selection if there is one, otherwise paste.
		this.bodyEl.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			if (this.term?.hasSelection()) {
				const sel = this.term.getSelection();
				if (sel) this.writeClipboard(sel);
				this.term.clearSelection();
			} else {
				this.pasteFromClipboard();
			}
		});
		// Paste is owned solely by our handlers (Ctrl+V keydown + the right-click above). Swallow
		// xterm's native paste in the capture phase so a right-click doesn't paste twice.
		this.bodyEl.addEventListener('paste', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
		this.fitThrottle = new FitThrottle({
			// Kane lives in a fixed-width dock (never bubbles), so fit it to its actual size —
			// no minimum clamp (clamping would clip his own readable content).
			propose: () => this.fit?.proposeDimensions() ?? null,
			apply: (cols, rows) => { this.term?.resize(cols, rows); this.bridge?.resize(cols, rows); },
		});
		this.fitSoon();

		// Forward FIRST, then track: a notice released by this very keystroke (his Enter) must
		// reach the PTY after it, never before.
		this.term.onData((d) => { this.bridge?.write(d); this.gate.input(d, this.pasting); });
		// resume → Kane picks his conversation back up across app restarts, exactly like the
		// tiles (fresh fallback if no transcript). /clear inside the session starts a new one.
		this.startSession(this.opts.resume ?? false, this.opts.resume ?? false);

		this.resizeObs = new ResizeObserver(() => this.fitSoon());
		this.resizeObs.observe(this.bodyEl);

		// The same Claude-hook ready marker the tiles watch for, in this console's home dir (its
		// cwd, so the Stop hook's `node notify-ready.cjs` writes it there — see writeKaneCommands).
		// Its only job here is to resync the draft tracker: a turn ending bounds how long a
		// mis-tracked draft can hold the queue. It does NOT mean "flush anyway" — the gate
		// decides, and refuses while the keyboard is demonstrably busy.
		try {
			this.readyWatcher = fs.watch(this.opts.godHomeDir, (_evt, file) => {
				if (file !== '.cos-ready') return;
				try { fs.unlinkSync(path.join(this.opts.godHomeDir, '.cos-ready')); } catch { /* ignore */ }
				this.gate.ready();
			});
		} catch { /* home dir gone / watch unsupported — the badge still offers a way through */ }
	}

	/** Build args/env, create Kane's session bridge, wire it, and start it. Called from render()
	 *  and from refresh(). resume → resume this console's own conversation (see resumeArgs);
	 *  fallbackFresh → if that resume cannot start, relaunch a FRESH session in place, so ⟳
	 *  revives a dead Kane instead of re-running the same doomed command. */
	private startSession(resume: boolean, fallbackFresh = false): void {
		const ctxFile = this.writeSystemPromptFile();
		this.writeKaneCommands();
		const args: string[] = resume ? this.resumeArgs() : [];
		if (ctxFile) args.push('--append-system-prompt-file', ctxFile);
		const sidecarDir = path.dirname(this.opts.sidecarPath);
		const env: Record<string, string> = {
			...safeSessionEnv(this.opts.sessionEnv),
			COS_COORD_DIR: this.opts.coordDir,
			COS_TERMINAL_ID: this.opts.terminalId ?? '0',
			COS_TERMINAL_NAME: this.opts.instanceName ?? 'Kane',
			COS_ROLE: 'god',
			PATH: sidecarDir + path.delimiter + (process.env.PATH ?? ''),
		};
		fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
		let probe = ''; // first bytes only (capped) — the refusal text a failed resume prints
		const startedAt = Date.now();
		this.bridge = new SessionBridge(this.opts.sidecarPath, this.opts.godHomeDir, 'claude', args, env);
		this.bridge.onData((d) => { if (fallbackFresh && probe.length < 2048) probe += d; this.term?.write(d); this.markBusy(); });
		this.bridge.onTranscriptOff(() => this.opts.onTranscriptOff?.());
		this.bridge.onExit((code) => {
			const name = this.opts.instanceName ?? 'Kane';
			if (shouldStartFresh({ fallbackFresh, probe, elapsedMs: Date.now() - startedAt })) {
				// Say WHY, both here and in devtools: a silent reset is indistinguishable from
				// "my history vanished for no reason". The new TUI may paint over the line, so the
				// console.warn is the copy that survives.
				console.warn(`[god] ${name}: resume failed (code ${code ?? '?'}), starting fresh. First output:`, probe.slice(0, 500));
				this.term?.reset();
				this.term?.write(`\r\n[${name} could not resume the previous conversation — starting a fresh session]\r\n`);
				this.startSession(false); // fallbackFresh defaults false → a fresh session can never loop back here
				return;
			}
			this.term?.write(`\r\n[${name} session ended (code ${code ?? '?'})]\r\n`);
		});
		this.bridge.start();
	}

	/** Args that resume THIS console's own conversation.
	 *
	 *  Bare `--continue` takes the newest transcript in this home's project folder, which a
	 *  background job forked off a previous console can outrank — that is how the primary console
	 *  came back dead after a restart while an orphaned job still held the session (2026-09-16).
	 *  When such a job is on disk we name the file we want instead. Everything else — no job, no
	 *  project folder yet, an unreadable one — falls through to the old `--continue`, so a home
	 *  that never spawned a job takes exactly the path it always did. */
	private resumeArgs(): string[] {
		const CONTINUE = ['--continue'];
		try {
			const home = process.env.USERPROFILE || process.env.HOME;
			if (!home) return CONTINUE;
			const projectDir = path.join(home, '.claude', 'projects', projectDirName(this.opts.godHomeDir));
			const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
			if (files.length === 0) return CONTINUE; // nothing to resume — --continue starts fresh itself
			const jobsDir = path.join(home, '.claude', 'jobs');
			const jobs: JobRecord[] = [];
			for (const id of fs.readdirSync(jobsDir)) {
				try {
					const st = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')) as { linkScanPath?: string };
					jobs.push({ linkScanPath: st.linkScanPath }); // matched by PATH — a job folder's id is a short prefix of its transcript's
				} catch { /* a plain file (pins.json), a job mid-write, a job without a transcript */ }
			}
			const orphans = orphanTranscripts(jobs, projectDir);
			if (orphans.size === 0) return CONTINUE; // nothing to disambiguate — unchanged behaviour
			const pick = pickResumeFile(files.map((f) => ({
				file: path.join(projectDir, f),
				mtimeMs: fs.statSync(path.join(projectDir, f)).mtimeMs,
			})), orphans);
			// Every transcript here belongs to a background job → none of them is this console's
			// conversation, so start fresh rather than adopting a stranger's.
			return pick ? ['--resume', pick] : [];
		} catch { return CONTINUE; }
	}

	/** Kane has no ready-marker, so approximate "busy" from output activity: any output marks
	 *  busy and (re)arms a short timer that clears it once output goes quiet. */
	private markBusy(): void {
		this.busy = true;
		if (this.busyTimer !== null) window.clearTimeout(this.busyTimer);
		this.busyTimer = window.setTimeout(() => { this.busy = false; this.busyTimer = null; }, 1500);
	}

	/** Re-tint the terminal well live (theme switch — see theme-store). Font weight and the
	 *  contrast floor travel with the palette: light wells need both to read well. */
	setTerminalPalette(p: TerminalPalette): void {
		if (!this.term) return;
		this.term.options.theme = p;
		const f = activeTerminalFont();
		this.term.options.fontWeight = f.fontWeight as never;
		this.term.options.fontWeightBold = f.fontWeightBold as never;
		this.term.options.minimumContrastRatio = f.minimumContrastRatio;
	}

	/** Refresh Kane: kill + relaunch in place, resuming his conversation.
	 *  Confirms first only if he's mid-output. */
	async refresh(): Promise<void> {
		if (this.busy) {
			const ok = await promptForConfirm('Refresh Kane?', 'Kane is mid-response. Refreshing interrupts it and reloads with --continue (the conversation is kept).', 'Refresh');
			if (!ok) return;
		}
		this.restartInPlace();
	}

	/** Restart Kane's session in place WITHOUT confirming — the account switch uses this so
	 *  a live Kane moves to the new session env too (env re-read inside startSession). */
	restartInPlace(): void {
		if (this.busyTimer !== null) { window.clearTimeout(this.busyTimer); this.busyTimer = null; }
		this.busy = false;
		this.bridge?.kill();
		this.term?.reset();
		// New TUI, empty input box — but anything queued is KEPT and goes out on the next ready
		// marker, rather than being typed into a session that is still booting.
		this.gate.reset();
		this.startSession(true, true); // try to resume; if that cannot start, fall back to a fresh session
	}

	/** Show/hide the panel WITHOUT killing the session. Refits on show. */
	setVisible(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? '' : 'none';
		if (on) { this.fitSoon(); this.focus(); }
	}

	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }

	/** Live-rename the console: update the header label + the name used for future system-prompt /
	 *  settings writes. The RUNNING session's self-identity (already-spawned claude) only changes on
	 *  its next start/refresh — but the visible label updates instantly. */
	setDisplayName(name: string): void {
		this.opts.instanceName = name;
		this.nameSpan?.setText(`🜲 ${name}`);
	}

	/** Last ≤20 non-blank lines of Kane's buffer — for the phone floor view. */
	recentOutput(): string {
		const t = this.term;
		if (!t) return '';
		const buf = t.buffer.active; const lines: string[] = [];
		for (let i = buf.length - 1; i >= 0 && lines.length < 20; i--) {
			const row = buf.getLine(i); if (!row) continue;
			const s = row.translateToString(true).trimEnd(); if (s) lines.unshift(s);
		}
		return lines.join('\n');
	}

	/** Inject a line into Kane's session — used to ping him when a watch fires.
	 *
	 *  Goes through the gate: if the user has unsubmitted text in Kane's input box, the notice
	 *  WAITS (and the header badge says so) instead of being typed into the middle of his
	 *  sentence and submitted with it. An empty box delivers immediately, as it always did. */
	notify(text: string): void {
		this.gate.notify(text);
	}

	/** The actual injection: text + a separated Enter so ConPTY can't coalesce them. Only the
	 *  gate calls this. */
	private writeNotice(text: string): void {
		this.bridge?.write(text);
		// 250ms + a 900ms retry: match TerminalTile.sendLine — the new TUI's wider paste
		// window eats a fast \r; the second Enter is a no-op on an already-submitted box.
		window.setTimeout(() => this.bridge?.write('\r'), 250);
		window.setTimeout(() => this.bridge?.write('\r'), 900);
	}

	/** Show/hide the "N waiting" badge in the header. */
	private renderQueueBadge(n: number): void {
		const el = this.queueEl;
		if (!el) return;
		el.style.display = n > 0 ? '' : 'none';
		if (n === 0) return;
		const who = this.opts.instanceName ?? 'Kane';
		el.setText(`⏳ ${n} waiting`);
		el.setAttr('title', `${n} notice${n === 1 ? '' : 's'} waiting for ${who} — press Enter or clear the line (Esc / Ctrl+U) and ${n === 1 ? 'it' : 'they'} will be delivered. Click to deliver now (into whatever is in the box).`);
	}

	/** Scroll this terminal's scrollback buffer per a keyboard scroll intent. */
	private applyScroll(intent: ScrollIntent): void {
		const t = this.term;
		if (!t) return;
		if (intent.kind === 'lines') t.scrollLines(intent.amount);
		else if (intent.kind === 'pages') t.scrollPages(intent.amount);
		else if (intent.kind === 'top') t.scrollToTop();
		else t.scrollToBottom();
	}

	/** Alternate-screen (flicker-free) TUI: no xterm scrollback, so map a scroll intent to Claude's
	 *  native scroll keys down the PTY — wheel ticks for line up/down (≈3 lines, like before), PgUp/
	 *  PgDn for page, Ctrl+Home/Ctrl+End for top/bottom. */
	private sendScrollKey(intent: ScrollIntent): void {
		let seq: string;
		if (intent.kind === 'top') seq = '\x1b[1;5H';
		else if (intent.kind === 'bottom') seq = '\x1b[1;5F';
		else if (intent.kind === 'pages') seq = intent.amount < 0 ? '\x1b[5~' : '\x1b[6~';
		else seq = intent.amount < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M';
		this.bridge?.write(seq);
	}

	/** Paste clipboard text into the terminal (honors bracketed-paste via term.paste). */
	private pasteFromClipboard(): void {
		void readClipboardText().then((txt) => {
			if (!txt) return;
			// Flag the paste so the draft tracker counts it as typing rather than reading the
			// newlines inside it as submits (they land in the box; they don't send).
			this.pasting = true;
			try { this.term?.paste(txt); } finally { this.pasting = false; }
		});
	}

	/** Copy text to the clipboard (used by right-click when there's a selection). */
	private writeClipboard(text: string): void {
		writeClipboardText(text);
	}

	/** Coalesce resize bursts into a single fit + pty-resize (see FitThrottle). */
	private fitSoon(): void {
		this.fitThrottle?.schedule();
	}

	/** Drop a project-level `/personality` slash command + a scoped settings file into Kane's
	 *  home dir. The command makes Kane run `cos-coord personality` (the app drains it and flips
	 *  the mode); the settings pre-allow `cos-coord` so the toggle/tell/watch/spawn don't each
	 *  pop a permission prompt. Everything else still prompts (Kane stays non-bypass). */
	private writeKaneCommands(): void {
		try {
			const cmdDir = path.join(this.opts.godHomeDir, '.claude', 'commands');
			fs.mkdirSync(cmdDir, { recursive: true });
			fs.writeFileSync(path.join(cmdDir, 'personality.md'), [
				'---',
				`description: Toggle ${this.opts.instanceName ?? 'Kane'}'s personality (forge-master persona + periodic floor pulses) on/off`,
				'---',
				'Run exactly this command and nothing else, then confirm in one short line:',
				'',
				'```bash',
				'cos-coord personality',
				'```',
				'',
				'It toggles your personality mode — the app handles the persona switch and starts or',
				'stops the periodic floor "[pulse]" nudges. Do not do anything else.',
				'',
			].join('\n'), 'utf8');
			const settingsFile = path.join(this.opts.godHomeDir, '.claude', 'settings.json');
			// Task-matcher hooks so background Task/Agent runs the overseer launches also log to the
			// board (feeds the Coordination panel's background-tasks list), same as worker terminals.
			const coordHookAbsPath = path.join(path.dirname(this.opts.sidecarPath), 'coord-hook.cjs');
			const task = (extra: string) => ({ matcher: 'Task', hooks: [{ type: 'command', command: `node "${coordHookAbsPath}" --task${extra}` }] });
			// Stop hook → the .cos-ready marker in this console's cwd, watched in render(). The
			// tiles use Stop AND Notification; this console takes Stop only, on purpose: the
			// marker's one job here is to resync the draft tracker, and Notification also fires
			// when Claude has been idle waiting for input — precisely when an untouched draft is
			// most likely to be sitting in the box.
			const notifyReadyAbsPath = path.join(path.dirname(this.opts.sidecarPath), 'notify-ready.cjs');
			const ready = [{ hooks: [{ type: 'command', command: `node "${notifyReadyAbsPath}"` }] }];
			// With self-improvement enabled, the overseer also gets prompt-free file edits +
			// git/npm/node, or "builds it and lets you know" would stall on a permission prompt
			// per edit.
			const allow = ['Bash(cos-coord:*)', ...(this.opts.selfImprove ? ['Edit', 'Write', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(node:*)'] : [])];
			fs.writeFileSync(settingsFile, JSON.stringify({
				permissions: { allow },
				hooks: { Stop: ready, PreToolUse: [task('')], PostToolUse: [task(' --release')] },
			}, null, 2), 'utf8');
		} catch { /* best effort — /personality still works, just with a permission prompt */ }
	}

	/** Write GOD's appended system prompt to his home dir; return the path (or null). */
	private writeSystemPromptFile(): string | null {
		try {
			fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
			const file = path.join(this.opts.godHomeDir, 'god-system-prompt.md');
			fs.writeFileSync(file, this.systemPrompt(), 'utf8');
			return file;
		} catch { return null; }
	}

	/** The overseer's appended system prompt: the vault's `alpha` role file when one is configured
	 *  and loadable, else godSystemPrompt unchanged. The facts are exactly the values that builder
	 *  interpolates — the floor's targets, the coordination directory, this console's name, and
	 *  the self-improvement paths when that is configured. */
	private systemPrompt(): string {
		const name = this.opts.instanceName ?? 'Kane';
		const si = this.opts.selfImprove;
		const targets = this.opts.repos.length
			? this.opts.repos.map((r) => `- ${r.name} → ${r.path}${r.folder ? '   [plain folder — no git]' : ''}`).join('\n')
			: '- (no targets added yet)';
		const facts: SessionFact[] = [
			{ label: 'overseer name', value: name },
			{ label: 'coordination directory', value: this.opts.coordDir },
			{ label: 'targets on the floor (name → path)', value: targets },
			// Only present when self-improvement is configured: the built-in prompt omits the whole
			// carve-out in that case, so naming the paths anyway would grant more than it did.
			...(si ? [
				{ label: 'own source repo', value: si.sourceRepo },
				{ label: 'standalone tools directory', value: si.toolsDir },
			] : []),
		];
		return loadRolePrompt(this.opts.roleLibraryPath, 'alpha', facts)
			?? godSystemPrompt(this.opts.repos, this.opts.coordDir, name, si);
	}

	/** Full teardown — kills the session. */
	dispose(): void {
		// Removing a focused element fires no focusout — clear the grid's focus flag manually.
		if (this.el?.contains(document.activeElement)) this.opts.onFocusChange?.(false);
		this.resizeObs?.disconnect(); this.resizeObs = null;
		this.readyWatcher?.close(); this.readyWatcher = null;
		this.fitThrottle?.dispose(); this.fitThrottle = null;
		this.bridge?.kill(); this.bridge = null;
		this.term?.dispose(); this.term = null;
		this.el?.remove(); this.el = this.bodyEl = null;
	}
}
