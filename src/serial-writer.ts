/** Serializes async read-modify-write cycles against one shared resource.
 *
 *  Fire-and-forget `read().then(write)` pairs look harmless but race: two overlapping cycles
 *  both read the OLD value, and whichever write lands last silently discards the other's
 *  change. TerminalsGrid learned this the hard way — a stale snapshot landing last is how
 *  CARDTSAR lost every terminal record (2026-07-30) — and its persistChain is the same idea,
 *  scoped to the sessions file. This is that pattern extracted so config.json gets it too.
 *
 *  Jobs run one at a time, in the order pushed. A job that throws is swallowed (best-effort
 *  persistence must never wedge the chain for everything queued behind it), so callers that
 *  care about failure should report it inside the job. */
export class SerialWriter {
	private chain: Promise<void> = Promise.resolve();

	/** Queue a job to run after every previously-pushed one. Returns when THIS job is done.
	 *  Take the state snapshot INSIDE the job, not at push time — that is what makes the last
	 *  queued write the newest one rather than the oldest. */
	push(job: () => Promise<void>): Promise<void> {
		const run = this.chain.then(job).catch(() => { /* best effort — never wedge the chain */ });
		this.chain = run;
		return run;
	}

	/** Resolves when the queue has drained. Useful on teardown. */
	idle(): Promise<void> { return this.chain; }
}
