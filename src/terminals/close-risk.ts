/** Thin IO beside close-summary.ts: ask git what each worktree would lose. Two probes per
 *  worktree, both bounded and both fail-safe — a probe that errors or times out reports
 *  `unknown`, never "clean", because the whole point of the dialog is to stop a close that
 *  would throw away work nobody verified was safe to throw away. */

import { runCommand } from '../command-runner';
import { parseStatusPorcelain } from './worktree-registry';
import type { WorktreeRisk } from './close-summary';

const PROBE_TIMEOUT_MS = 8000;

/** Probe one worktree. Never throws. */
export async function probeWorktreeRisk(worktreePath: string, baseBranch: string): Promise<WorktreeRisk> {
	try {
		const status = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath, timeoutMs: PROBE_TIMEOUT_MS });
		if (status.code !== 0) return { dirtyFiles: 0, unpushed: 0, unknown: true };
		const revs = await runCommand('git', ['rev-list', '--count', `${baseBranch}..HEAD`], { cwd: worktreePath, timeoutMs: PROBE_TIMEOUT_MS });
		const dirtyFiles = parseStatusPorcelain(status.stdout).length;
		// A missing base branch makes rev-list fail; the dirty count is still real, so report
		// what we know and mark the commit side unverified rather than discarding both.
		if (revs.code !== 0) return { dirtyFiles, unpushed: 0, unknown: true };
		return { dirtyFiles, unpushed: parseInt(revs.stdout.trim() || '0', 10) || 0 };
	} catch {
		return { dirtyFiles: 0, unpushed: 0, unknown: true };
	}
}

/** Probe every target, in parallel, keyed by worktree path for closeConfirmMessage. */
export async function probeWorktreeRisks(
	targets: { worktreePath: string; baseBranch: string }[],
): Promise<Record<string, WorktreeRisk>> {
	const out: Record<string, WorktreeRisk> = {};
	await Promise.all(targets.map(async (t) => { out[t.worktreePath] = await probeWorktreeRisk(t.worktreePath, t.baseBranch); }));
	return out;
}
