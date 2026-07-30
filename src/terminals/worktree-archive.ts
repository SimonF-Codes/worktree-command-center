/** Archiving stale worktrees to zip, browsing what's archived, and reviving one.
 *
 *  The problem: worktrees stack up. Every Play creates `wt/<base>-N`, closing a terminal only
 *  deletes the worktree if it's pristine, and a closed-terminal worktree lingers forever with its
 *  full node_modules. This module gives each one an end state: a single .zip plus two small
 *  sidecar files that can be read WITHOUT inflating anything.
 *
 *      <archiveDir>/<repo>__<branch>__<stamp>.zip    the worktree files + the conversation
 *      <archiveDir>/<repo>__<branch>__<stamp>.json   manifest — what the browser lists from
 *      <archiveDir>/<repo>__<branch>__<stamp>.md     human summary of the conversation
 *
 *  What goes in the zip: only git-visible files (`git ls-files --cached --others
 *  --exclude-standard`), so no .git and no node_modules — that's where the space saving comes
 *  from — plus the Claude Code transcript directory, which is what makes a revive resume the
 *  actual conversation instead of starting a blank session.
 *
 *  What survives outside the zip: the branch. Commits are never zip-only; the zip carries the
 *  working state and the conversation.
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { runCommand } from '../command-runner';
import { buildZip, type ZipEntry } from './zip-writer';
import { readZip } from './zip-reader';
import { parkWorktree, slugify } from './worktree-manager';
import {
	projectDirFor, projectSlug, listFilesRecursive, readConversations,
	formatConversationSummary, type ConversationDigest,
} from './conversation-archive';

/** Per-file and per-archive ceilings. A single huge artifact (a checked-in binary, a stray dump)
 *  is skipped and noted rather than blowing up the archive it's caught in. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sweep policy (pure)
// ---------------------------------------------------------------------------

export interface SweepPolicy {
	enabled: boolean;
	/** Archive an unowned worktree once it's been untouched this long. */
	maxAgeDays: number;
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = { enabled: true, maxAgeDays: 7 };

/** Read a policy out of the persisted config, defaulting anything malformed. Also the guard that
 *  keeps a nonsense `maxAgeDays` (0, negative, NaN) from turning the sweep into "delete
 *  everything immediately" — it floors at 1 day. */
export function normalizeSweepPolicy(raw: unknown): SweepPolicy {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SweepPolicy>;
	const days = Number(o.maxAgeDays);
	return {
		enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_SWEEP_POLICY.enabled,
		maxAgeDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_SWEEP_POLICY.maxAgeDays,
	};
}

/** What the sweep needs to know about one worktree to decide its fate. */
export interface SweepCandidate {
	branch: string;
	path: string;
	/** True when a live tile is attached — those are never touched, at any age. */
	hasTerminal: boolean;
	/** Epoch ms of the most recent sign of life (see latestActivity). */
	lastActivity: number;
}

/** Whether the auto-sweep should archive this worktree. An owned worktree is always spared, and
 *  the age test is the ONLY thing that makes an unowned one eligible — dirty/ahead state doesn't
 *  block it, because archiving parks the work and keeps the branch. */
export function shouldAutoArchive(c: SweepCandidate, now: number, p: SweepPolicy): boolean {
	if (!p.enabled) return false;
	if (c.hasTerminal) return false;
	if (!Number.isFinite(c.lastActivity) || c.lastActivity <= 0) return false;
	return now - c.lastActivity >= p.maxAgeDays * 86_400_000;
}

/** The most recent of several activity signals, ignoring junk (0/NaN/future-dated). */
export function latestActivity(times: Array<number | undefined | null>, now = Date.now()): number {
	let best = 0;
	for (const t of times) {
		const n = Number(t);
		if (!Number.isFinite(n) || n <= 0) continue;
		best = Math.max(best, Math.min(n, now));
	}
	return best;
}

// ---------------------------------------------------------------------------
// Naming (pure)
// ---------------------------------------------------------------------------

/** `20260730-011542` — sortable, filesystem-safe, second resolution. */
export function timeStamp(d: Date): string {
	const p = (n: number, w = 2): string => String(n).padStart(w, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The distinct base name every archive's three files share. Repo + branch + stamp, so two
 *  archives of the same branch never collide and the listing sorts chronologically per branch. */
export function archiveBaseName(repo: string, branch: string, when: Date): string {
	return `${slugify(repo) || 'repo'}__${slugify(branch) || 'branch'}__${timeStamp(when)}`;
}

/** Where archives live. Kept out of the repos (never syncs to a cloud folder, never confuses git)
 *  and out of `.claude-worktrees` (which is the thing being cleaned up). */
export function archiveDirFor(userData: string): string {
	return path.join(userData, 'worktree-archives');
}

export function humanBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '?';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ArchiveManifest {
	version: 1;
	base: string;                 // the shared base name (no extension)
	repo: string;
	repoPath: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;         // where it must be recreated for --continue to match
	projectSlug: string;          // Claude Code's transcript dir name for that path
	terminalName: string;
	archivedAt: string;           // ISO
	archivedAtMs: number;
	reason: 'sweep' | 'manual';
	headCommit: string;
	headSubject: string;
	parked: boolean;              // uncommitted work was committed before archiving
	fileCount: number;
	skippedFiles: string[];       // too big / unreadable
	zipBytes: number;
	rawBytes: number;             // uncompressed total, for the "saved" figure
	/** Enough of each conversation to browse without inflating the zip. */
	conversations: Array<{
		sessionId: string; title: string; firstTs: string; lastTs: string;
		userMessages: number; assistantMessages: number; hasSummary: boolean;
	}>;
}

/** Parse a manifest defensively — a hand-edited or half-written file must not break the listing. */
export function parseManifest(text: string): ArchiveManifest | null {
	try {
		const o = JSON.parse(text) as ArchiveManifest;
		if (!o || typeof o !== 'object' || typeof o.base !== 'string' || !o.base) return null;
		return {
			...o,
			version: 1,
			repo: String(o.repo ?? ''),
			branch: String(o.branch ?? ''),
			worktreePath: String(o.worktreePath ?? ''),
			archivedAtMs: Number(o.archivedAtMs) || 0,
			zipBytes: Number(o.zipBytes) || 0,
			rawBytes: Number(o.rawBytes) || 0,
			fileCount: Number(o.fileCount) || 0,
			conversations: Array.isArray(o.conversations) ? o.conversations : [],
			skippedFiles: Array.isArray(o.skippedFiles) ? o.skippedFiles : [],
		};
	} catch {
		return null;
	}
}

/** Newest-first listing of everything in the archive folder. */
export async function listArchives(archiveDir: string): Promise<ArchiveManifest[]> {
	let names: string[];
	try { names = await fsp.readdir(archiveDir); } catch { return []; }
	const out: ArchiveManifest[] = [];
	for (const n of names) {
		if (!n.endsWith('.json')) continue;
		try {
			const m = parseManifest(await fsp.readFile(path.join(archiveDir, n), 'utf8'));
			if (m) out.push(m);
		} catch { /* skip unreadable manifest */ }
	}
	return out.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
}

/** The human summary that sits beside the zip — read straight off disk, no inflation. */
export async function readArchiveSummary(archiveDir: string, base: string): Promise<string> {
	try { return await fsp.readFile(path.join(archiveDir, `${base}.md`), 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

export interface ArchiveTarget {
	repoName: string;
	repoPath: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;
	terminalName?: string;
}

export interface ArchiveResult {
	ok: boolean;
	manifest?: ArchiveManifest;
	error?: string;
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
	const r = await runCommand('git', args, { cwd, timeoutMs: 20_000 });
	return r.code === 0 ? r.stdout : '';
}

/** Archive one worktree: park → zip (files + conversation) → write manifest/summary → delete the
 *  worktree directory, keeping the branch.
 *
 *  Ordering is the safety property: the worktree is only removed AFTER the zip is on disk and
 *  fsync'd into place under its final name. Any failure before that leaves everything untouched
 *  and returns `{ ok: false }`. */
export async function archiveWorktree(
	target: ArchiveTarget,
	archiveDir: string,
	opts: { reason?: 'sweep' | 'manual'; now?: Date; home?: string } = {},
): Promise<ArchiveResult> {
	const now = opts.now ?? new Date();
	const home = opts.home ?? os.homedir();
	const reason = opts.reason ?? 'manual';
	const { repoName, repoPath, branch, baseBranch, worktreePath } = target;

	try {
		let exists = true;
		try { await fsp.access(worktreePath); } catch { exists = false; }

		// A worktree whose folder is already gone is a stale git registration, not something to
		// archive — prune it and say so rather than writing an empty archive.
		if (!exists) {
			await runCommand('git', ['worktree', 'prune'], { cwd: repoPath, timeoutMs: 15_000 });
			return { ok: false, error: 'worktree folder is already gone (pruned the stale registration)' };
		}

		// 1. Park uncommitted work so the commits live on the branch, not only in the zip.
		const parkAction = await parkWorktree(worktreePath, now.toISOString());
		if (parkAction === 'failed') return { ok: false, error: 'could not park uncommitted work — nothing was archived' };
		const parked = parkAction === 'parked';

		const headCommit = (await gitOut(worktreePath, ['rev-parse', 'HEAD'])).trim();
		const headSubject = (await gitOut(worktreePath, ['log', '-1', '--pretty=%s'])).trim();

		// 2. Collect git-visible files only: tracked + untracked-not-ignored. This is what excludes
		//    node_modules/dist/.git without needing a hand-maintained skip list.
		const ls = await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: worktreePath, timeoutMs: 30_000 });
		if (ls.code !== 0) return { ok: false, error: 'git ls-files failed — nothing was archived' };
		const relFiles = ls.stdout.split('\0').map((s) => s.trim()).filter(Boolean);

		const entries: ZipEntry[] = [];
		const skipped: string[] = [];
		let rawBytes = 0;
		let worktreeFiles = 0; // counted separately from `entries`, which also holds the conversation + metadata
		for (const rel of relFiles) {
			const abs = path.join(worktreePath, rel);
			try {
				const st = await fsp.stat(abs);
				if (!st.isFile()) continue;
				if (st.size > MAX_FILE_BYTES || rawBytes + st.size > MAX_TOTAL_BYTES) { skipped.push(rel); continue; }
				entries.push({ name: `worktree/${rel}`, data: await fsp.readFile(abs), mtime: st.mtime });
				rawBytes += st.size;
				worktreeFiles++;
			} catch { skipped.push(rel); }
		}

		// 3. Collect the conversation: the whole Claude Code project dir for this CWD.
		const convos: ConversationDigest[] = await readConversations(worktreePath, home);
		const slug = projectSlug(worktreePath);
		const projDir = projectDirFor(worktreePath, home);
		for (const rel of await listFilesRecursive(projDir)) {
			const abs = path.join(projDir, rel);
			try {
				const st = await fsp.stat(abs);
				if (st.size > MAX_FILE_BYTES || rawBytes + st.size > MAX_TOTAL_BYTES) { skipped.push(`conversation/${rel}`); continue; }
				entries.push({ name: `conversation/${slug}/${rel}`, data: await fsp.readFile(abs), mtime: st.mtime });
				rawBytes += st.size;
			} catch { skipped.push(`conversation/${rel}`); }
		}

		const base = archiveBaseName(repoName, branch, now);
		const zipPath = path.join(archiveDir, `${base}.zip`);

		// 4. Summary + manifest. Both go inside the zip (so it's self-describing if moved) AND
		//    beside it (so browsing costs one readdir + small reads). Identical copies — the summary
		//    reports uncompressed bytes precisely so the in-zip copy isn't describing a size it
		//    cannot know yet.
		const summary = formatConversationSummary({
			repo: repoName, branch, worktreePath, archivedAt: now.toISOString(),
			headSubject, parked, fileCount: worktreeFiles, rawBytes,
		}, convos);
		const manifest: ArchiveManifest = {
			version: 1, base, repo: repoName, repoPath, branch, baseBranch, worktreePath,
			projectSlug: slug, terminalName: target.terminalName ?? '',
			archivedAt: now.toISOString(), archivedAtMs: now.getTime(), reason,
			headCommit, headSubject, parked,
			fileCount: worktreeFiles, skippedFiles: skipped,
			// The copy embedded below necessarily carries zipBytes: 0 — the zip's own size isn't known
			// until it's built. The sidecar manifest written in step 5 has the real figure.
			zipBytes: 0, rawBytes,
			conversations: convos.map((c) => ({
				sessionId: c.sessionId, title: c.title, firstTs: c.firstTs, lastTs: c.lastTs,
				userMessages: c.userMessages, assistantMessages: c.assistantMessages,
				hasSummary: c.compactSummaries.length > 0,
			})),
		};
		entries.push({ name: 'ARCHIVE.md', data: Buffer.from(summary, 'utf8'), mtime: now });
		entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: now });

		// 5. Write the zip to a .part first, then rename — a crash mid-write can never leave a
		//    truncated .zip that the listing would treat as a real archive.
		const zip = buildZip(entries, now);
		await fsp.mkdir(archiveDir, { recursive: true });
		const partPath = `${zipPath}.part`;
		await fsp.writeFile(partPath, zip);
		await fsp.rename(partPath, zipPath);

		manifest.zipBytes = zip.length;
		await fsp.writeFile(path.join(archiveDir, `${base}.json`), JSON.stringify(manifest, null, 2), 'utf8');
		await fsp.writeFile(path.join(archiveDir, `${base}.md`), summary, 'utf8');

		// 6. Only now is it safe to reclaim the space. --force because the park may have left the
		//    worktree with a submodule/untracked residue git would otherwise refuse to remove.
		const rm = await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeoutMs: 30_000 });
		if (rm.code !== 0) {
			// git refused (locked worktree, in-use file). Fall back to a plain delete + prune so the
			// space is still reclaimed; the zip is already safely written either way.
			try { await fsp.rm(worktreePath, { recursive: true, force: true }); } catch { /* leave it */ }
			await runCommand('git', ['worktree', 'prune'], { cwd: repoPath, timeoutMs: 15_000 });
		}

		// 7. Drop the transcript dir — it's inside the zip now, and leaving it behind both wastes
		//    the space we just reclaimed and would let a future worktree at this same path resume
		//    THIS conversation by accident.
		try { await fsp.rm(projDir, { recursive: true, force: true }); } catch { /* best effort */ }

		return { ok: true, manifest };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------------------------------------------------------------------------
// Reviving
// ---------------------------------------------------------------------------

export interface ReviveResult {
	ok: boolean;
	/** Everything the grid needs to open a tile on the restored worktree. */
	restored?: { repoName: string; repoPath: string; branch: string; baseBranch: string; worktreePath: string; terminalName: string; conversationRestored: boolean };
	/** Set when the branch was gone and had to be recreated — commits could not be recovered. */
	warning?: string;
	error?: string;
}

/** Resolve an archive member to an absolute path under `root`, or null if it would escape it.
 *  readZip already normalizes away `..`, so this is belt-and-braces against a hand-made zip. */
export function safeJoin(root: string, rel: string): string | null {
	const abs = path.resolve(root, rel);
	const base = path.resolve(root);
	if (abs !== base && !abs.startsWith(base + path.sep)) return null;
	return abs;
}

async function writeEntry(root: string, rel: string, data: Buffer): Promise<void> {
	const abs = safeJoin(root, rel);
	if (!abs) return;
	await fsp.mkdir(path.dirname(abs), { recursive: true });
	await fsp.writeFile(abs, data);
}

/** Bring an archive back to life: recreate the worktree at its ORIGINAL path (required — the
 *  transcript is keyed by CWD), restore the files and the conversation, and hand the caller what
 *  it needs to open a `claude --continue` tile.
 *
 *  Non-destructive by design: refuses if something already occupies the worktree path, and never
 *  deletes the archive — reviving twice is allowed. */
export async function reviveArchive(
	manifest: ArchiveManifest,
	archiveDir: string,
	opts: { home?: string; repoPathOverride?: string } = {},
): Promise<ReviveResult> {
	const home = opts.home ?? os.homedir();
	const repoPath = opts.repoPathOverride ?? manifest.repoPath;
	const { branch, worktreePath } = manifest;
	let warning: string | undefined;

	try {
		if (!worktreePath || !branch) return { ok: false, error: 'archive manifest is missing its worktree path or branch' };

		let occupied = true;
		try { await fsp.access(worktreePath); } catch { occupied = false; }
		if (occupied) return { ok: false, error: `${worktreePath} already exists — remove or archive it first` };

		let zip: Buffer;
		try { zip = await fsp.readFile(path.join(archiveDir, `${manifest.base}.zip`)); }
		catch { return { ok: false, error: 'archive .zip is missing' }; }
		const entries = readZip(zip);

		// Recreate the worktree. Normal case: the branch is still in the repo, so this restores
		// every commit. If the branch was deleted out from under us, fall back to cutting a fresh
		// one from the base and rely on the zip for the file state (commits are unrecoverable).
		const hasBranch = (await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath, timeoutMs: 10_000 })).code === 0;
		const add = hasBranch
			? await runCommand('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath, timeoutMs: 30_000 })
			: await runCommand('git', ['worktree', 'add', worktreePath, '-b', branch, manifest.baseBranch || 'HEAD'], { cwd: repoPath, timeoutMs: 30_000 });
		if (add.code !== 0) {
			return { ok: false, error: (add.error ?? add.stderr).split('\n')[0] || 'git worktree add failed' };
		}
		if (!hasBranch) warning = `branch "${branch}" no longer existed — recreated from ${manifest.baseBranch || 'HEAD'}; its commits are not recoverable, only the archived files`;

		// Restore the files exactly as they were at archive time (this is what brings back work that
		// was dirty rather than committed), then the transcript dir.
		const projectsRoot = path.join(home, '.claude', 'projects');
		let conversationRestored = false;
		for (const e of entries) {
			if (e.name.startsWith('worktree/')) {
				await writeEntry(worktreePath, e.name.slice('worktree/'.length), e.data);
			} else if (e.name.startsWith('conversation/')) {
				await writeEntry(projectsRoot, e.name.slice('conversation/'.length), e.data);
				if (e.name.endsWith('.jsonl')) conversationRestored = true;
			}
		}

		return {
			ok: true,
			warning,
			restored: {
				repoName: manifest.repo, repoPath, branch,
				baseBranch: manifest.baseBranch || 'main',
				worktreePath,
				terminalName: manifest.terminalName || branch,
				conversationRestored,
			},
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Delete an archive's three files. Used by the browser's ✕ — the only way archives ever shrink. */
export async function deleteArchive(archiveDir: string, base: string): Promise<void> {
	for (const ext of ['.zip', '.json', '.md']) {
		try { await fsp.rm(path.join(archiveDir, `${base}${ext}`), { force: true }); } catch { /* best effort */ }
	}
}
