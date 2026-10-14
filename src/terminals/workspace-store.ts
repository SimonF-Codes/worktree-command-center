/** Pure workspace-list logic — no IO/DOM, so it unit-tests cleanly. A workspace is a named,
 *  id'd group; the id is filesystem-safe (used for the coordination dir + sessions key). */

/** `repo`, when present, is the absolute path of the target this tab was created FOR — the repo
 *  picked or created in the new-tab dialog. A path rather than a name because the floor looks
 *  targets up by name and two repos can share one. Absent on every tab made before tabs were
 *  born linked, and on a tab deliberately made without one: such a tab behaves exactly as before. */
export interface Workspace { id: string; name: string; repo?: string; }

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

/** Point a tab at a repo path, or unlink it with `undefined`. Immutable; an unknown id is a no-op. */
export function linkWorkspaceRepo(list: Workspace[], id: string, repo: string | undefined): Workspace[] {
	return list.map((w) => {
		if (w.id !== id) return w;
		const { repo: _old, ...rest } = w;
		return repo ? { ...rest, repo } : rest;
	});
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
				out.push({ id: ws.id, name: ws.name, ...(typeof ws.repo === 'string' && ws.repo ? { repo: ws.repo } : {}) });
			}
		}
	}
	return out.length ? out : [{ id: 'default', name: 'default' }];
}
