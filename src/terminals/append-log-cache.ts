// Fold an append-only coordination log only when it has changed. The Project panel, the Manager view
// and the sidebar's ◆N all re-read their logs every 1–2 s on the window's thread; re-parsing an
// unchanged file each time cost ~30 ms a tick at a year of heavy use (step 11's profile). An
// append-only file that changed has changed SIZE, so (size, mtime) is a sound key — no content hash.
import * as fs from 'fs';

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
