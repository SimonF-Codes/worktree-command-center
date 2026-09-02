import { describe, it, expect } from 'vitest';
import { SPAWN_MODELS, MODEL_ALIASES, isDatedModelId, validateSpawnModels } from '../src/terminals/spawn-models';

describe('SPAWN_MODELS', () => {
	it('is healthy', () => {
		expect(validateSpawnModels()).toEqual([]);
	});

	it('starts with the inherit-the-CLI-default option', () => {
		expect(SPAWN_MODELS[0]).toEqual({ label: 'Model: Default', value: '' });
	});

	it('offers every alias, so the list cannot go stale when a new model ships', () => {
		for (const a of MODEL_ALIASES) expect(SPAWN_MODELS.map((m) => m.value)).toContain(a);
	});

	it('offers the current flagship pinned id', () => {
		// The regression that prompted this module: the list named Opus 4.8 as the top Opus
		// long after Opus 5 shipped.
		expect(SPAWN_MODELS.map((m) => m.value)).toContain('claude-opus-5');
	});

	it('pins no dated snapshot ids', () => {
		// It used to carry claude-haiku-4-5-20251001; the canonical id is claude-haiku-4-5.
		expect(SPAWN_MODELS.filter((m) => isDatedModelId(m.value))).toEqual([]);
	});

	it('has no duplicate values', () => {
		const values = SPAWN_MODELS.map((m) => m.value);
		expect(new Set(values).size).toBe(values.length);
	});
});

describe('isDatedModelId', () => {
	it('flags dated snapshots', () => {
		expect(isDatedModelId('claude-haiku-4-5-20251001')).toBe(true);
		expect(isDatedModelId('claude-opus-4-5-20251101')).toBe(true);
	});
	it('passes canonical ids and aliases', () => {
		expect(isDatedModelId('claude-haiku-4-5')).toBe(false);
		expect(isDatedModelId('claude-opus-5')).toBe(false);
		expect(isDatedModelId('opus')).toBe(false);
		expect(isDatedModelId('')).toBe(false);
	});
});

describe('validateSpawnModels', () => {
	const ok = [
		{ label: 'Model: Default', value: '' },
		...MODEL_ALIASES.map((a) => ({ label: a, value: a })),
	];

	it('accepts a minimal healthy list', () => {
		expect(validateSpawnModels(ok)).toEqual([]);
	});

	it('rejects a missing default row', () => {
		expect(validateSpawnModels(ok.slice(1)).join(' ')).toMatch(/first option/);
	});

	it('rejects a dated snapshot id', () => {
		expect(validateSpawnModels([...ok, { label: 'Old', value: 'claude-haiku-4-5-20251001' }]).join(' '))
			.toMatch(/dated snapshot/);
	});

	it('rejects a list with no aliases — the stale-by-construction shape', () => {
		const pinnedOnly = [{ label: 'Model: Default', value: '' }, { label: 'Opus 5', value: 'claude-opus-5' }];
		expect(validateSpawnModels(pinnedOnly)).toHaveLength(MODEL_ALIASES.length);
	});

	it('rejects duplicates and unlabelled options', () => {
		expect(validateSpawnModels([...ok, { label: 'dup', value: 'opus' }]).join(' ')).toMatch(/duplicate/);
		expect(validateSpawnModels([...ok, { label: '  ', value: 'claude-opus-5' }]).join(' ')).toMatch(/no label/);
	});

	it('rejects a value that is neither an alias nor a claude-* id', () => {
		expect(validateSpawnModels([...ok, { label: 'GPT', value: 'gpt-5' }]).join(' ')).toMatch(/neither an alias/);
	});
});
