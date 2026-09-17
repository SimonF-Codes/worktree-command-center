// Which transcript an overseer console should resume.
//
// Bare `claude --continue` takes the NEWEST transcript in the home's project folder. That is the
// right guess until the console spawns a background job: the job forks its own session into the
// same folder, keeps writing after the console is gone, and so outranks the console's own
// conversation. On the next launch --continue then reaches for the job's transcript — which the
// daemon may still hold open, leaving the console dead on arrival (2026-09-16, `.god/default`).
//
// So: find the background jobs writing into this folder and resume the newest transcript that is
// NOT one of theirs, by name. Callers fall back to plain --continue when there is nothing to
// disambiguate, which keeps every home without a job on exactly the old path.
//
// Everything here matches on the transcript PATH a job records, never on a session id: a job's
// folder is named with a short id (`45d9196d`) while its transcript carries the full uuid
// (`45d9196d-8a96-…`), so keying by id silently matches nothing.

import * as path from 'path';

/** Claude Code's on-disk name for a working directory's transcript folder: every character that
 *  is not a letter or digit becomes a hyphen, so `C:\dev\Brain_2.0` → `C--dev-Brain-2-0`. */
export function projectDirName(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** A transcript file sitting in a console home's project folder. */
export interface Transcript { file: string; mtimeMs: number }

/** A background job as `~/.claude/jobs/<id>/state.json` records it. `linkScanPath` is the
 *  absolute path of the transcript that job writes. */
export interface JobRecord { linkScanPath?: string }

/** Compare paths the way two different writers spell them: either separator, any case, no
 *  trailing slash. Claude writes `linkScanPath`; we build the folder with path.join. */
function norm(p: string): string {
	return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Normalised paths of the transcripts owned by background jobs in `projectDir`.
 *
 *  At RESTORE time these are orphans by construction: no console for this home exists yet, so any
 *  job writing into its folder was spawned by a console that is already gone. */
export function orphanTranscripts(jobs: readonly JobRecord[], projectDir: string): Set<string> {
	const dir = norm(projectDir);
	const out = new Set<string>();
	for (const j of jobs) {
		if (!j.linkScanPath) continue;
		if (norm(path.dirname(j.linkScanPath)) === dir) out.add(norm(j.linkScanPath));
	}
	return out;
}

/** The transcript to resume: the newest one that is not a background job's. Null when every
 *  transcript in the folder belongs to a job — the caller then starts fresh rather than resuming
 *  a conversation that was never this console's. */
export function pickResumeFile(transcripts: readonly Transcript[], orphans: ReadonlySet<string>): string | null {
	let best: Transcript | null = null;
	for (const t of transcripts) {
		if (orphans.has(norm(t.file))) continue;
		if (!best || t.mtimeMs > best.mtimeMs) best = t;
	}
	return best?.file ?? null;
}
