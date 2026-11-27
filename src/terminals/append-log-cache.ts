// Fold an append-only coordination log only when it has changed. The Project panel, the Manager view
// and the sidebar's ◆N all re-read their logs every 1–2 s on the window's thread; re-parsing an
// unchanged file each time cost ~30 ms a tick at a year of heavy use (step 11's profile). An
// append-only file that changed has changed SIZE, so (size, mtime) is a sound key — no content hash.
import * as fs from 'fs';
import * as path from 'path';

const cache = new Map<string, { size: number; mtimeMs: number; value: unknown }>();

/** `fold(text)` of `file`, recomputed only when the file's size or mtime moved. A missing or
 *  unreadable file folds as empty text. Callers must treat the result as read-only: it is shared. */
export function foldCached<T>(file: string, fold: (text: string) => T): T {
	let st: fs.Stats | null = null;
	try { st = fs.statSync(file); } catch { /* missing */ }
	if (!st) { cache.delete(file); return fold(''); }
	const hit = cache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value as T;
	let text = '';
	try { text = fs.readFileSync(file, 'utf8'); } catch { /* raced away */ }
	const value = fold(text);
	cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
	return value;
}

// The same idea for a FOLDER of files that never change once they are in it — `god-outbox/.done/`,
// where the app renames each request it has acted on (Session Transfers, P5a). A folder has no size
// that moves, so the key is its modified time and its entry count: renaming a file in moves the
// folder's mtime (measured on NTFS, 2026-11-27), and the count is the second key for a file system
// whose mtime is coarse. On a hit no file is opened at all. On a miss only the files not already
// held are read — a claimed request is never rewritten — and the ones that left are dropped.

/** The three calls the folder cache makes, injectable so a test can count them. */
export interface FolderIo {
	mtimeMs(dir: string): number | null;
	list(dir: string): string[] | null;
	read(file: string): string | null;
}

const realFolderIo: FolderIo = {
	mtimeMs: (dir) => { try { return fs.statSync(dir).mtimeMs; } catch { return null; } },
	list: (dir) => { try { return fs.readdirSync(dir); } catch { return null; } },
	read: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
};

export interface FolderFile { file: string; text: string }

const folders = new Map<string, { mtimeMs: number; count: number; files: Map<string, string>; value: FolderFile[] }>();

/** Every file in `dir` whose name passes `accept`, with its text, sorted by name. A missing folder
 *  reads as empty. The result is shared across callers: treat it as read-only. */
export function readFolderCached(dir: string, accept: (name: string) => boolean = (n) => n.endsWith('.json'), io: FolderIo = realFolderIo): FolderFile[] {
	const mtimeMs = io.mtimeMs(dir);
	const names = mtimeMs === null ? null : io.list(dir);
	if (mtimeMs === null || names === null) { folders.delete(dir); return []; }
	const wanted = names.filter(accept).sort();
	const hit = folders.get(dir);
	if (hit && hit.mtimeMs === mtimeMs && hit.count === names.length) return hit.value;
	const files = new Map<string, string>();
	let complete = true;
	for (const n of wanted) {
		const held = hit?.files.get(n);
		const text = held ?? io.read(path.join(dir, n));
		if (text === null) { complete = false; continue; } // raced away, or not yet readable: try again next time
		files.set(n, text);
	}
	const value = [...files].map(([file, text]) => ({ file, text }));
	// An incomplete read is not keyed, so the next call looks again rather than trusting it.
	folders.set(dir, { mtimeMs: complete ? mtimeMs : Number.NaN, count: names.length, files, value });
	return value;
}
