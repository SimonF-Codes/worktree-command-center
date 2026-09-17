import { indexProcesses, subtreePids, type ProcRow } from './process-snapshot';

/** How long a process must have been CONTINUOUSLY unattributed before it may be offered.
 *
 *  Age is the whole safety mechanism, because "unattributed" is NOT a synonym for "leaked". It
 *  means "under this app's pid, claimed by no session", and on a healthy floor that set holds
 *  `git` invoked by the coordination hooks on every Bash call, `cos-coord` itself, and their
 *  conhosts. Killing one of those mid-write can leave an `index.lock` or a half-written ref in
 *  a repo eight terminals share, and the damage surfaces much later as a confusing lock in
 *  someone else's worktree.
 *
 *  The two populations differ by orders of magnitude in lifetime — transients live for seconds,
 *  a leaked `claude` lives for hours — so a gate anywhere in between separates them cleanly. */
export const STALE_MS = 3 * 60_000;

/** …and how many consecutive snapshots it must have appeared in. BOTH gates, never one.
 *
 *  The poll cadence changes: 60s with the widget alone, 20s with the panel open. At 60s a time
 *  threshold on its own would qualify a process on its second sample, which is not evidence of
 *  anything. At 20s a poll count on its own would qualify one after a minute. */
export const MIN_POLLS = 3;

/** A process that has been unattributed for at least one poll, with the evidence against it. */
export interface TrackedProc {
	pid: number;
	name: string;
	rssBytes: number;
	/** Win32 creation time. The other half of the identity — see `procKey`. */
	startedAt: number;
	/** When it was first seen UNATTRIBUTED, which is not when it started: the tracker only
	 *  knows what it has watched. Deliberately the conservative of the two — a process that
	 *  started an hour before the app did still has to earn its three minutes. */
	firstSeen: number;
	/** Consecutive snapshots it has been unattributed in, this one included. */
	polls: number;
}

/** Keyed by pid + start time. Rebuilt from each snapshot, which is what makes a gap reset. */
export type UnattributedState = ReadonlyMap<string, TrackedProc>;

/** The starting state, for a monitor that has not polled yet. */
export const EMPTY_UNATTRIBUTED: UnattributedState = new Map();

/** One tree the action would end: the pid handed to `killProcessTree` and everything that dies
 *  with it. Grouped so the result can be reported honestly — a tree whose kill was REFUSED must
 *  not have its bytes counted as freed. */
export interface CloseableTree {
	root: number;
	/** Every pid in the tree, the root included. All of them are eligible; see `closeable`. */
	pids: number[];
	rssBytes: number;
}

export interface CloseablePlan {
	/** Every process the action would end, biggest first — what the confirm lists, one by one. */
	victims: TrackedProc[];
	/** The roots to kill. Fewer than `victims` whenever an eligible process has eligible
	 *  children: `killProcessTree` takes the whole tree, so killing both would kill the child
	 *  twice and report the second as a success on a process that was already gone. */
	trees: CloseableTree[];
	totalBytes: number;
}

/** pid + creation time. NEVER the pid alone.
 *
 *  Windows recycles pids. Keying persistence on the pid means a recycled pid inherits the
 *  accumulated age of whatever held the number before it, and the button then offers to kill
 *  something four seconds old with an apparent age of four hours. That bug would be nearly
 *  impossible to reproduce in the wild, so it is pinned by a test instead. */
function procKey(p: { pid: number; startedAt: number }): string {
	return `${p.pid}@${p.startedAt}`;
}

/** Fold one snapshot into the persistence record.
 *
 *  The new state is built FROM SCRATCH out of the current snapshot, which is what makes any gap
 *  reset the clock: a process missing from one poll loses its entry, and if the pid comes back
 *  it comes back as a new process with a fresh `firstSeen` — either because it really is one, or
 *  because it is a recycled number, and the tracker is not entitled to tell those apart.
 *
 *  A process whose start time could not be read is skipped entirely. It has no identity that
 *  survives pid reuse, so it is never tracked and can therefore never be offered. Reporting it
 *  is still honest; killing it would not be.
 *
 *  Pure: same inputs, same output, no clock of its own. */
export function trackUnattributed(
	prev: UnattributedState,
	rows: readonly ProcRow[],
	unattributedPids: readonly number[],
	now: number,
): UnattributedState {
	const stray = new Set(unattributedPids);
	const next = new Map<string, TrackedProc>();
	for (const r of rows) {
		if (!stray.has(r.pid) || r.startedAt === undefined) continue;
		const key = procKey({ pid: r.pid, startedAt: r.startedAt });
		const was = prev.get(key);
		next.set(key, {
			pid: r.pid,
			name: r.name,
			rssBytes: r.rssBytes,
			startedAt: r.startedAt,
			firstSeen: was?.firstSeen ?? now,
			polls: (was?.polls ?? 0) + 1,
		});
	}
	return next;
}

/** What the close action would actually do, given the latest snapshot and the record so far.
 *
 *  Three rules, each of which has to hold:
 *
 *  1. A process is ELIGIBLE only when it has been unattributed in every snapshot since it was
 *     first seen, for at least `staleMs` AND at least `minPolls` polls.
 *  2. A process is CLOSEABLE only when every descendant of it in the snapshot is eligible too.
 *     `killProcessTree` kills the tree, so a stale parent with a four-second-old `git` beneath
 *     it would take the `git` with it — the exact harm the age gate exists to prevent. Waiting
 *     one more poll costs nothing; the `git` will be gone by then. This is also what guarantees
 *     nothing a session claims is ever touched: claimed pids are not in the unattributed set,
 *     so they are never eligible, so any tree containing one is refused whole.
 *  3. The kill list is the ROOTS of those closeable trees, not every pid in them.
 *
 *  Pure, and takes `now` rather than reading a clock, so every rule above is a unit test. */
export function closeableUnattributed(
	rows: readonly ProcRow[],
	state: UnattributedState,
	now: number,
	opts: { staleMs?: number; minPolls?: number } = {},
): CloseablePlan {
	const staleMs = opts.staleMs ?? STALE_MS;
	const minPolls = opts.minPolls ?? MIN_POLLS;

	const ripe = new Map<number, TrackedProc>();
	for (const t of state.values()) {
		if (now - t.firstSeen >= staleMs && t.polls >= minPolls) ripe.set(t.pid, t);
	}

	const ix = indexProcesses(rows);
	const closeable = new Map<number, number[]>();
	for (const pid of ripe.keys()) {
		const tree = subtreePids(ix, pid);
		// An empty tree means the pid is not in this snapshot at all: it died between the poll
		// and the click. Nothing to kill, and certainly nothing to kill by that number now.
		if (tree.length && tree.every((p) => ripe.has(p))) closeable.set(pid, tree);
	}

	const trees: CloseableTree[] = [];
	for (const [pid, pids] of closeable) {
		const ppid = ix.byPid.get(pid)?.ppid;
		if (ppid !== undefined && closeable.has(ppid)) continue; // an ancestor's kill covers it
		trees.push({ root: pid, pids, rssBytes: pids.reduce((a, p) => a + (ix.byPid.get(p)?.rssBytes ?? 0), 0) });
	}

	// Biggest first, matching the panel: the question being answered is "what is holding the
	// memory", and that is the order the answer arrives in.
	const victims = [...closeable.keys()]
		.map((pid) => ripe.get(pid)!)
		.sort((a, b) => b.rssBytes - a.rssBytes || a.name.localeCompare(b.name) || a.pid - b.pid);

	return { victims, trees, totalBytes: victims.reduce((a, v) => a + v.rssBytes, 0) };
}
