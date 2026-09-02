/** Model options for the spawn toolbar — a pure list plus the checks that keep it honest.
 *
 *  Lives here rather than inline in terminals-grid.ts so it can be unit-tested: tests cannot
 *  import that module (it pulls in xterm and the DOM).
 *
 *  WHY ALIASES COME FIRST. The claude CLI accepts either an alias for the newest release in a
 *  family ('opus', 'sonnet', 'haiku', 'fable') or a full model id. The list used to offer only
 *  pinned ids, so it silently rotted: it still named Opus 4.8 as the top Opus after Opus 5
 *  shipped, and carried `claude-haiku-4-5-20251001` — a dated snapshot, not the canonical id.
 *  The alias rows cannot go stale, because the CLI resolves them at spawn time. The pinned rows
 *  below them are for reproducing a run on an exact version, and are the only ones that need
 *  touching when Anthropic ships a new model.
 *
 *  Anthropic's canonical ids are the bare family form — `claude-haiku-4-5`, never a dated
 *  variant. validateSpawnModels() enforces that, so the old shape cannot come back unnoticed. */

export interface ModelOption { label: string; value: string; }

/** CLI aliases that always resolve to the newest release in their family. */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const SPAWN_MODELS: ModelOption[] = [
	{ label: 'Model: Default', value: '' },   // '' = pass no --model, inherit the CLI default
	// Always-current: resolved by the CLI at spawn time.
	{ label: 'Opus (latest)', value: 'opus' },
	{ label: 'Sonnet (latest)', value: 'sonnet' },
	{ label: 'Haiku (latest)', value: 'haiku' },
	{ label: 'Fable (latest)', value: 'fable' },
	// Pinned: exact versions, for reproducing a run on a known model.
	{ label: 'Opus 5', value: 'claude-opus-5' },
	{ label: 'Opus 4.8', value: 'claude-opus-4-8' },
	{ label: 'Sonnet 5', value: 'claude-sonnet-5' },
	{ label: 'Haiku 4.5', value: 'claude-haiku-4-5' },
	{ label: 'Fable 5', value: 'claude-fable-5' },
];

/** A dated snapshot id such as `claude-haiku-4-5-20251001`. These are the ids that rot — the
 *  canonical form is the bare family id. */
export function isDatedModelId(value: string): boolean {
	return /-\d{8}$/.test(value);
}

/** Problems with a model list; an empty array means it is healthy. Run by the unit tests, so the
 *  list cannot quietly drift back to a stale or malformed shape. */
export function validateSpawnModels(options: ModelOption[] = SPAWN_MODELS): string[] {
	const problems: string[] = [];
	if (options[0]?.value !== '') problems.push('the first option must be the inherit-the-CLI-default empty value');

	const seen = new Set<string>();
	for (const o of options) {
		if (seen.has(o.value)) problems.push(`duplicate option value: "${o.value}"`);
		seen.add(o.value);
		if (!o.label.trim()) problems.push(`option "${o.value}" has no label`);
		if (!o.value) continue;                                   // the default row
		if ((MODEL_ALIASES as readonly string[]).includes(o.value)) continue;
		if (isDatedModelId(o.value)) problems.push(`dated snapshot id "${o.value}" — use the bare family id`);
		if (!o.value.startsWith('claude-')) problems.push(`"${o.value}" is neither an alias nor a claude-* model id`);
	}

	for (const a of MODEL_ALIASES) {
		if (!options.some((o) => o.value === a)) problems.push(`missing the "${a}" alias — pinned ids alone go stale`);
	}
	return problems;
}
