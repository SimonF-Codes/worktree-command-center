// The Project panel's numbers come from a CHILD PROCESS (V2 D11): `node wcc-team.cjs metrics --json
// --workspace <id>`. Git never runs in the renderer's process. runCommand already hands every spawn
// to the main process (command-runner.ts), so nothing here, or in the panel, imports child_process.
//
// On demand when the panel opens, and otherwise at most every five minutes while it stays open
// (METRICS_REFRESH_MS) — the caller decides when; this runs, de-duplicates and remembers.
import { runCommand, type CommandResult } from '../command-runner';
import type { ProjectReport } from '../core/metrics';
import type { TeamMetricsOutput, Timing } from '../cli/team-cli';

export interface MetricsRun {
	workspaceId: string;
	report: ProjectReport | null;
	/** Why there is no report, verbatim — rendered in place of every value. */
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
	/** Spawn → exit as the app saw it: the cost of a refresh, node start-up included. */
	roundTripMs: number | null;
	/** What wcc-team measured of itself (wall time, every git call). */
	timing: Timing | null;
}

export interface ProjectMetricsDeps {
	cliPath: string;
	userData: string;
	run?: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<CommandResult>;
	now?: () => number;
	log?: (line: string) => void;
}

export class ProjectMetricsRunner {
	private last = new Map<string, MetricsRun>();
	private inflight = new Map<string, Promise<MetricsRun>>();

	constructor(private deps: ProjectMetricsDeps) {}

	private now(): number { return this.deps.now?.() ?? Date.now(); }

	latest(workspaceId: string): MetricsRun | null { return this.last.get(workspaceId) ?? null; }
	running(workspaceId: string): boolean { return this.inflight.has(workspaceId); }

	/** Run wcc-team for one workspace, or join the run already in flight for it. Never rejects. */
	refresh(workspaceId: string): Promise<MetricsRun> {
		const cur = this.inflight.get(workspaceId);
		if (cur) return cur;
		const startedAt = this.now();
		const p = (async (): Promise<MetricsRun> => {
			const run = this.deps.run ?? ((c, a, o) => runCommand(c, a, o));
			const r = await run('node', [this.deps.cliPath, 'metrics', '--json', '--workspace', workspaceId, '--user-data', this.deps.userData], { timeoutMs: 60_000 });
			const finishedAt = this.now();
			const base = { workspaceId, startedAt, finishedAt, roundTripMs: finishedAt - startedAt };
			const firstErr = (r.stderr || r.error || '').split('\n').find((l) => l.trim()) ?? '';
			let out: MetricsRun;
			if (r.timedOut) out = { ...base, report: null, timing: null, error: 'wcc-team did not finish within 60 s' };
			else if (r.code !== 0) out = { ...base, report: null, timing: null, error: `wcc-team failed (exit ${r.code ?? 'none'}): ${firstErr || 'no output'}` };
			else {
				try {
					const o = JSON.parse(r.stdout) as TeamMetricsOutput;
					const report = o.workspaces.find((w) => w.workspaceId === workspaceId) ?? null;
					out = { ...base, report, timing: o.timing, error: report ? null : `wcc-team returned no report for "${workspaceId}"` };
				} catch (e) {
					out = { ...base, report: null, timing: null, error: `wcc-team printed something that is not its JSON: ${(e as Error).message}` };
				}
			}
			this.deps.log?.(`[wcc-team] ${workspaceId}: round trip ${out.roundTripMs} ms${firstErr ? ` · ${firstErr}` : ''}`);
			this.last.set(workspaceId, out);
			return out;
		})().finally(() => { this.inflight.delete(workspaceId); });
		this.inflight.set(workspaceId, p);
		return p;
	}
}
