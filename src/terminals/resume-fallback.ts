// When a console launched with --continue/--resume dies, decide whether to retry it FRESH.
//
// This used to be one string match on "no conversation found to continue". Any other refusal left
// the console dead behind a `[… session ended (code N)]` line, and ⟳ re-ran the identical doomed
// command — which is how the primary overseer console stayed down across a restart while an
// orphaned background job still held its transcript (2026-09-16).

/** A resume that never got off the ground exits inside this window. A console that really came
 *  back is still painting its TUI at this point and will not exit for minutes, so the window is
 *  the general rule and the message list below is only a fast path for a SLOW refusal. */
export const RESUME_FAIL_WINDOW_MS = 4000;

/** Refusals worth catching even when the process took longer than the window to give up — a
 *  multi-megabyte transcript can. Deliberately not exhaustive: the window covers the rest,
 *  including wording we have never seen. */
const REFUSALS: readonly RegExp[] = [
	/no conversation found to continue/i,
	/no conversation to resume/i,
	/already in use/i,
	/in use by another/i,
	/failed to (resume|continue)/i,
];

/** The output a resuming session wrote, kept so its exit can be judged. Capped, because a session
 *  that really came back keeps writing for hours.
 *
 *  Keeps the LAST bytes, not the first: a refusal is the final thing claude prints before it
 *  exits, but it is not always near the start. In a home dir claude has never seen — every new 🜲+
 *  duplicate's — the workspace-trust dialog comes first, and its paint (repainted on every resize
 *  while it waits) ran past a 2048-byte head. The refusal was never seen, the exit came long after
 *  RESUME_FAIL_WINDOW_MS because a person had to answer the dialog, and the console stayed dead. */
export class ResumeProbe {
	private buf = '';

	constructor(private readonly cap: number) {}

	feed(chunk: string): void {
		this.buf = (this.buf + chunk).slice(-this.cap);
	}

	get text(): string { return this.buf; }
}

export interface ResumeExit {
	/** False for a session that was already fresh — it has nothing to fall back to. */
	fallbackFresh: boolean;
	/** The first bytes the session wrote, capped by the caller. */
	probe: string;
	/** How long the session lived, in ms. */
	elapsedMs: number;
}

/** Whether this exit should be retried as a fresh session. The retry always runs with
 *  `fallbackFresh: false`, so a fresh session that dies too can never loop back in here. */
export function shouldStartFresh({ fallbackFresh, probe, elapsedMs }: ResumeExit): boolean {
	if (!fallbackFresh) return false;
	if (REFUSALS.some((re) => re.test(probe))) return true;
	return elapsedMs < RESUME_FAIL_WINDOW_MS;
}
