import { SessionBridge, safeSessionEnv } from './session-bridge';
import { parseUsage, stripAnsi, type UsageReadout } from './usage-parse';
import { looksLikeMenu } from './prompt-detect';

export interface UsageProbeOpts { sidecarPath: string; cwd: string; sessionEnv?: () => Record<string, string>; }

/** Drives a hidden `claude` session to read `/usage` on demand — a FRESH session per
 *  refresh: the CLI fetches limit data once per process and re-renders that snapshot on
 *  every reopen, so a reused session can never show new numbers (verified empirically —
 *  two /usage passes in one live session came back byte-identical with no re-fetch).
 *  `/usage` is a local command — this consumes no tokens. No worktree, no UI. */
export class UsageProbe {
	private bridge: SessionBridge | null = null;
	private buf = '';
	private ready = false;

	constructor(private opts: UsageProbeOpts) {}

	private ensureSession(): Promise<void> {
		if (this.bridge && this.ready) return Promise.resolve();
		if (!this.bridge) {
			const b = new SessionBridge(this.opts.sidecarPath, this.opts.cwd, 'claude', [], safeSessionEnv(this.opts.sessionEnv));
			this.bridge = b;
			// Every callback is guarded on `this.bridge === b`. THIS IS THE LEAK FIX. These
			// closures outlive the bridge they belong to: a killed session's `exit` lands a few
			// hundred ms later, by which time the retry below has already installed a NEW bridge.
			// Unguarded, the dead session's exit nulled `this.bridge` out from under the live
			// one, refreshOnce() then threw 'session unavailable' before reaching dispose(), and
			// that live sidecar — whose pid nothing still held — leaked forever. One per refresh,
			// every five minutes, which is the 31 probe processes found on the machine.
			b.onData((d) => { if (this.bridge === b) this.buf += d; });
			b.onExit(() => { if (this.bridge === b) { this.bridge = null; this.ready = false; } });
			b.onReady(() => { if (this.bridge === b) this.ready = true; });
			// A probe session that refuses to die is exactly what went unnoticed for 31 refreshes.
			// The pid is kept by kill-tree's unconfirmedKills for the reaper to retry.
			b.onKillFailure((r) => console.error(`[wcc] usage probe: pid ${r.pid} survived kill — ${r.detail}`));
			b.start();
			// Since 2.1.211 the CLI renders /usage inside the tabbed Settings view, which is
			// taller than the PTY's default 24 rows — the Fable and credits sections fall below
			// the fold and never paint, so they can't be scraped. 50 rows fits the whole view.
			b.resize(80, 50);
		}
		// Resolve on first ready THAT ISN'T A MENU, or after a boot timeout (claude takes a few
		// seconds). A first-run prompt (e.g. "Claude in Chrome extension detected") also goes idle
		// and would otherwise look "ready" — sending "/usage" into it types menu-navigation
		// keystrokes instead of a command, and the probe never recovers. Dismiss any such menu with
		// Escape (the right call for a hidden background session either way — it should never pick
		// up tool/browser permissions) and keep waiting for the real prompt.
		const waitFor = this.bridge;
		return new Promise((resolve) => {
			const started = Date.now();
			const iv = window.setInterval(() => {
				// The session we were waiting on has been killed or replaced. Stop waiting —
				// readOnce() reports it — rather than steering Escapes into its successor.
				if (this.bridge !== waitFor) { window.clearInterval(iv); resolve(); return; }
				if (Date.now() - started > 9000) { window.clearInterval(iv); resolve(); return; }
				if (!this.ready) return;
				// Tail-only: the buffer accumulates for the whole session, so a menu dismissed
				// earlier is still in there — checking the full text would match it forever.
				if (looksLikeMenu(stripAnsi(this.buf).slice(-1000))) { this.ready = false; waitFor?.write('\x1b'); return; }
				window.clearInterval(iv);
				resolve();
			}, 200);
		});
	}

	/** Refresh: boot a session, open /usage, wait for the scan to settle, scrape, then kill
	 *  the session — the next refresh must be a new process to get a fresh fetch. */
	async refresh(): Promise<UsageReadout> {
		return this.refreshOnce(true);
	}

	private async refreshOnce(retryOnEmpty: boolean): Promise<UsageReadout> {
		// try/finally, not a trailing dispose(): ANY throw between here and the end used to skip
		// cleanup and strand a live `claude` + sidecar. Cleanup on the error path is the whole
		// difference between a failed refresh and a permanent 250 MB leak, so it is structural
		// now rather than a statement that happens to be reached.
		let readout: UsageReadout;
		try {
			readout = await this.readOnce();
		} finally {
			this.dispose(); // fresh session per refresh — see the class comment
		}
		// A first-ever session in the probe dir boots into claude's trust prompt, which eats
		// the /usage keystrokes (the Enter accepts the prompt — our own empty dir, safe). One
		// retry in the now-trusted dir self-heals that, and any other transient empty readout.
		if (readout.sessionPct === null && retryOnEmpty) return this.refreshOnce(false);
		return readout;
	}

	/** One boot → /usage → scrape pass. The caller owns teardown. */
	private async readOnce(): Promise<UsageReadout> {
		await this.ensureSession();
		const b = this.bridge;
		if (!b) throw new Error('usage probe: session unavailable');
		this.buf = '';
		// Submit like TerminalTile.sendLine: text first, then a SEPARATED Enter on a later tick.
		// Bundling "/usage\r" into one write makes the sidecar/ConPTY coalesce it so the \r lands
		// as a pasted newline that never submits — which is why the battery read 0 (it never ran).
		b.write('/usage');
		// 200ms: match TerminalTile.sendLine — the new TUI's wider paste window eats a fast \r.
		// Addressed to `b`, not `this.bridge`: if this pass has already been torn down, a stray
		// Enter must not land in whatever session came after it.
		window.setTimeout(() => { if (this.bridge === b) b.write('\r'); }, 200);
		const readout = await new Promise<UsageReadout>((resolve) => {
			const started = Date.now();
			let lastKey = '';
			const iv = window.setInterval(() => {
				const r = parseUsage(this.buf);
				const tail = stripAnsi(this.buf).slice(-200);
				const settled = r.sessionPct !== null && r.sessionReset !== null && !/scanning|refreshing/i.test(tail);
				// Settle needs one extra tick of stability: the tabbed view paints progressively
				// (a value was observed changing ~200 ms after the first complete parse), so only
				// resolve once two consecutive polls parse identically.
				const key = JSON.stringify(r);
				const stable = settled && key === lastKey;
				lastKey = key;
				if (stable || Date.now() - started > 12000) {
					window.clearInterval(iv);
					resolve(parseUsage(this.buf));
				}
			}, 400);
		});
		return readout;
	}

	/** Pid of the session this probe currently owns, if any. The stray reaper consults it so a
	 *  refresh that is mid-flight is never mistaken for a leak. */
	ownedPids(): number[] {
		const p = this.bridge?.pid;
		return typeof p === 'number' ? [p] : [];
	}

	dispose(): void { this.bridge?.kill(); this.bridge = null; this.ready = false; }
}
