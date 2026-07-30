/** Pure workspace-list logic — no IO/DOM, so it unit-tests cleanly. A workspace is a named,
 *  id'd group; the id is filesystem-safe (used for the coordination dir + sessions key). */

export interface Workspace { id: string; name: string; }

export function slugId(name: string): string {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

export function uniqueId(base: string, taken: string[]): string {
	if (!taken.includes(base)) return base;
	let n = 2;
	while (taken.includes(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export function addWorkspace(list: Workspace[], name: string): { list: Workspace[]; id: string } | null {
	const trimmed = String(name).trim();
	if (!trimmed) return null;
	const id = uniqueId(slugId(trimmed), list.map((w) => w.id));
	return { list: [...list, { id, name: trimmed }], id };
}

/** Rename a workspace's LABEL only — the id is deliberately left alone. The id names the
 *  coordination directory and keys the persisted session list, so changing it on a rename would
 *  orphan every running terminal and lose that workspace's board + journals. Returns null when
 *  nothing would change (unknown id, blank name, same name) so callers can skip a persist+redraw. */
export function renameWorkspace(list: Workspace[], id: string, name: string): Workspace[] | null {
	const trimmed = String(name).trim();
	if (!trimmed) return null;
	const target = list.find((w) => w.id === id);
	if (!target || target.name === trimmed) return null;
	return list.map((w) => (w.id === id ? { ...w, name: trimmed } : w));
}

export function closeWorkspace(list: Workspace[], id: string): Workspace[] {
	if (list.length <= 1) return list;
	const next = list.filter((w) => w.id !== id);
	return next.length ? next : list;
}

export function nextActiveAfter(list: Workspace[], closingId: string, active: string): string {
	if (active !== closingId) return active;
	const i = list.findIndex((w) => w.id === closingId);
	const survivors = list.filter((w) => w.id !== closingId);
	if (!survivors.length) return active;
	return i > 0 ? list[i - 1]!.id : survivors[0]!.id;
}

export function normalizeWorkspaces(raw: unknown): Workspace[] {
	const out: Workspace[] = [];
	if (Array.isArray(raw)) {
		for (const w of raw) {
			const ws = w as Workspace;
			if (ws && typeof ws.id === 'string' && typeof ws.name === 'string' && ws.id && !out.some((x) => x.id === ws.id)) {
				out.push({ id: ws.id, name: ws.name });
			}
		}
	}
	return out.length ? out : [{ id: 'default', name: 'default' }];
}
