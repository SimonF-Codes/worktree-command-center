import { ChildProcess, spawn } from 'child_process';
import { killProcessTree, type KillResult } from './kill-tree';
import { sanitizeSessionEnv, TranscriptOffWatch } from './session-env';

export interface Frame { t: string; [k: string]: unknown; }

export function encodeFrame(obj: Frame): string {
	return JSON.stringify(obj) + '\n';
}

export function decodeFrames(buffer: string): { frames: Frame[]; rest: string } {
	const frames: Frame[] = [];
	let rest = buffer;
	let i: number;
	while ((i = rest.indexOf('\n')) >= 0) {
		const line = rest.slice(0, i);
		rest = rest.slice(i + 1);
		if (!line.trim()) continue;
		try { frames.push(JSON.parse(line) as Frame); } catch { /* skip malformed */ }
	}
	return { frames, rest };
}

/**
 * Owns one sidecar child process running `claude` in a worktree via a PTY.
 * Spawns SYSTEM node (the `.exe` trick searches PATH and avoids Obsidian's
 * Electron execPath). Never throws on spawn failure — surfaces via onExit.
 */
export class SessionBridge {
	private proc: ChildProcess | null = null;
	private rxBuf = '';
	private onDataCb: ((utf8: string) => void) | null = null;
	private onExitCb: ((code: number | null) => void) | null = null;
	private onReadyCb: (() => void) | null = null;
	private onKillFailCb: ((r: KillResult & { ok: false }) => void) | null = null;
	private onTranscriptOffCb: (() => void) | null = null;
	private transcriptWatch = new TranscriptOffWatch();
	private killing: Promise<KillResult> | null = null;
	/** One death, one report. The sidecar sends an {t:'exit'} frame with claude's code and then
	 *  exits itself, so the same death also arrives as the process 'exit' event (code 0). Both
	 *  used to reach onExit: a tile's fresh-fallback ran twice and started two sessions, the
	 *  second orphaning the first. */
	private exited = false;
	/** Set once the owner asks for the kill. From then on this session's output and death are
	 *  not news to anyone: the owner has either torn down or already started its replacement,
	 *  and a late "[session ended (code 1)]" from the old one marked the live one dead. */
	private silenced = false;

	constructor(
		private sidecarPath: string,
		private cwd: string,
		private command = 'claude',
		private args: string[] = [],
		private extraEnv: Record<string, string> = {},
	) {}

	/** Pid of the sidecar process, or null once its death is confirmed. Exposed so a session's
	 *  memory can be attributed by rolling up this pid's subtree — exact ownership, with no
	 *  command-line string matching. */
	get pid(): number | null { return this.proc?.pid ?? null; }

	onData(cb: (utf8: string) => void): void { this.onDataCb = cb; }
	onExit(cb: (code: number | null) => void): void { this.onExitCb = cb; }
	/** Fired when the sidecar detects the session has gone idle (waiting for input). */
	onReady(cb: () => void): void { this.onReadyCb = cb; }
	/** Fired when a kill could not be confirmed, so the failure is visible instead of silent. */
	onKillFailure(cb: (r: KillResult & { ok: false }) => void): void { this.onKillFailCb = cb; }
	/** Fired once if claude's opening screen says transcript saving is off — the session will
	 *  not be resumable with --continue, so the caller should say so somewhere it will be seen. */
	onTranscriptOff(cb: () => void): void { this.onTranscriptOffCb = cb; }

	start(): void {
		const node = process.platform === 'win32' ? 'node.exe' : 'node';
		this.proc = spawn(node, [this.sidecarPath, this.cwd, this.command, ...this.args], {
			windowsHide: true,
			// Every spawn path — worker and folder tiles, the overseer console, the usage/format/
			// convert probes — comes through here, and the sidecar hands this env to claude as-is.
			// Strip the parent session's identity first (see session-env.ts); extraEnv is the app's
			// own and is applied after, so what the app sets deliberately still wins.
			env: { ...sanitizeSessionEnv(process.env), ...this.extraEnv },
			...(process.platform !== 'win32' ? { detached: true } : {}),
		});
		this.proc.stdout?.on('data', (d) => this.handleRx(d.toString('utf8')));
		this.proc.stderr?.on('data', () => { /* sidecar logs nothing to stderr normally */ });
		this.proc.on('error', (e) => { if (!this.silenced && !this.exited) this.reportExit(this.exitFromError(e)); });
		this.proc.on('exit', (code) => this.reportExit(code));
	}

	private reportExit(code: number | null): void {
		if (this.exited || this.silenced) return;
		this.exited = true;
		this.onExitCb?.(code);
	}

	write(utf8: string): void {
		this.send({ t: 'data', d: Buffer.from(utf8, 'utf8').toString('base64') });
	}

	resize(cols: number, rows: number): void {
		this.send({ t: 'resize', cols, rows });
	}

	/** Fire-and-forget entry point, kept because most call sites tear down synchronously.
	 *  The KILL itself is no longer fire-and-forget — see killTree(). */
	kill(): void { void this.killTree(); }

	/** Kill the sidecar and its whole process tree, VERIFYING that it took effect.
	 *
	 *  `this.proc` is deliberately NOT cleared until the kill is confirmed. The old code
	 *  cleared it unconditionally, so a kill that silently failed left a live process whose
	 *  pid nothing in the app still held — unreachable by anything but Task Manager. */
	killTree(): Promise<KillResult> {
		this.silenced = true; // even if the kill fails: onKillFailure, not onExit, reports that
		if (this.killing) return this.killing;
		const pid = this.proc?.pid;
		if (pid === undefined) { this.proc = null; return Promise.resolve({ ok: true, pid: null }); }
		this.killing = killProcessTree(pid, () => this.proc?.kill('SIGKILL')).then((r) => {
			this.killing = null;
			if (r.ok) this.proc = null; // only now is it safe to forget the pid
			else this.onKillFailCb?.(r);
			return r;
		});
		return this.killing;
	}

	private send(frame: Frame): void {
		try { this.proc?.stdin?.write(encodeFrame(frame)); } catch { /* pipe closed */ }
	}

	private handleRx(chunk: string): void {
		const { frames, rest } = decodeFrames(this.rxBuf + chunk);
		this.rxBuf = rest;
		for (const f of frames) {
			if (this.silenced) return;
			if (f.t === 'data' && typeof f.d === 'string') {
				const text = Buffer.from(f.d, 'base64').toString('utf8');
				this.onDataCb?.(text);
				if (this.transcriptWatch.feed(text)) this.onTranscriptOffCb?.();
			} else if (f.t === 'exit') {
				this.reportExit(typeof f.code === 'number' ? f.code : 0);
			} else if (f.t === 'ready') {
				this.onReadyCb?.();
			}
		}
	}

	private exitFromError(e: Error): number {
		this.onDataCb?.(`\r\n[failed to start session: ${e.message}]\r\n`);
		return 1;
	}
}

/** Overlay-provided extra env for a spawn (see docs/superpowers/specs/2026-07-13-session-env-provider-design.md).
 *  Never throws; {} when unset or failing — a buggy provider must not break spawning. */
export function safeSessionEnv(fn?: () => Record<string, string>): Record<string, string> {
	try { return fn?.() ?? {}; } catch { return {}; }
}
