// Test harness for `cos-coord spawn`: since spawn blocks on the app's receipt, a test that wants to
// see what it sent has to play the app's part — claim the dropped request the way drainOutbox does
// (rename it into .done/) and file a receipt the way spawnFromKane does.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');

export interface SpawnRun {
	code: number;
	stdout: string;
	stderr: string;
	/** The request exactly as cos-coord wrote it, or null when the app side never claimed one. */
	request: Record<string, unknown> | null;
}

/** What the fake app answers: a receipt to file, or null to claim the request and never answer. */
export type AppAnswer = (request: Record<string, unknown>) => Record<string, unknown> | null;

/** The receipt a successful spawn files (god.ts spawnReceipt's shape). */
export const accepted = (sessionId = 'sess-new', terminal = 'wt-main-7', branch = 'wt/main-7'): AppAnswer =>
	() => ({ ok: true, spawned: { terminal, branch, sessionId } });

/** Run `cos-coord spawn <args>` with `env`. With `answer`, a fake app claims the request and files
 *  that answer; without one, nothing ever claims it (the app is not running). */
export async function runSpawn(coordDir: string, args: string[], env: Record<string, string>, answer?: AppAnswer): Promise<SpawnRun> {
	const outbox = path.join(coordDir, 'god-outbox');
	let request: Record<string, unknown> | null = null;
	let stop = false;
	const app = answer ? (async () => {
		while (!stop) {
			let files: string[] = [];
			try { files = fs.readdirSync(outbox).filter((f) => f.endsWith('.json')); } catch { /* not yet */ }
			const f = files[0];
			if (f) {
				const full = path.join(outbox, f);
				const text = fs.readFileSync(full, 'utf8');
				fs.mkdirSync(path.join(outbox, '.done'), { recursive: true });
				fs.renameSync(full, path.join(outbox, '.done', f)); // claimed: withdraw() can no longer take it back
				request = JSON.parse(text) as Record<string, unknown>;
				const r = answer(request);
				if (r) {
					fs.mkdirSync(path.join(outbox, '.receipts'), { recursive: true });
					fs.writeFileSync(path.join(outbox, '.receipts', f), JSON.stringify(r), 'utf8');
				}
				return;
			}
			await new Promise((res) => setTimeout(res, 20));
		}
	})() : Promise.resolve();
	const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile('node', [CLI, 'spawn', ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
			resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});
	stop = true;
	await app;
	return { ...result, request };
}
