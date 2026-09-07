import { looksLikePrompt } from './chat-room';
import { looksLikeMenu, looksErrored } from './prompt-detect';

export type AttentionState = 'prompt' | 'menu' | 'errored' | 'idle';
export interface AttentionInput { id: number; name: string; repo: string; output: string; idle: boolean; }
export interface AttentionItem { id: number; name: string; repo: string; state: AttentionState; }

/** The three things a tab can be flagging, coarser than AttentionState — used for the per-tab
 *  marker + the pop-up notification, which distinguish only these buckets:
 *   - `input` : a permission prompt or selection menu is waiting on the user (prompt | menu)
 *   - `help`  : the session looks stuck / errored and wants a human (errored)
 *   - `done`  : the session finished its turn and is idle (idle) */
export type AttentionKind = 'input' | 'help' | 'done';

const RANK: Record<AttentionState, number> = { prompt: 0, menu: 1, errored: 2, idle: 3 };

/** Classify ONE terminal's recent output + idle flag, using the same precedence as the queue
 *  (prompt > menu > errored > idle). `'running'` means nothing to flag — busy and clean. Single
 *  source of truth shared by the topbar queue, the per-tab markers, and the notifications. */
export function classifyOne(output: string, idle: boolean): AttentionState | 'running' {
	if (looksLikePrompt(output)) return 'prompt';
	if (looksLikeMenu(output)) return 'menu';
	if (looksErrored(output)) return 'errored';
	return idle ? 'idle' : 'running';
}

/** Coarse bucket for the marker/notification, or null for a state that flags nothing. */
export function attentionKind(state: AttentionState | 'running'): AttentionKind | null {
	if (state === 'prompt' || state === 'menu') return 'input';
	if (state === 'errored') return 'help';
	if (state === 'idle') return 'done';
	return null;
}

/** Classify tiles by precedence prompt > menu > errored > idle; drop tiles with nothing to
 *  flag (busy + clean). Sorted by precedence, then id. */
export function classifyAttention(tiles: AttentionInput[]): AttentionItem[] {
	const out: AttentionItem[] = [];
	for (const t of tiles) {
		const state = classifyOne(t.output, t.idle);
		if (state !== 'running') out.push({ id: t.id, name: t.name, repo: t.repo, state });
	}
	return out.sort((a, b) => RANK[a.state] - RANK[b.state] || a.id - b.id);
}

/** Items that count toward the badge — everything except idle. */
export function actionCount(items: AttentionItem[]): number {
	return items.filter((i) => i.state !== 'idle').length;
}
