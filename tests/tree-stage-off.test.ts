import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import { drawScenes } from './grid-scenes';
import { mountGrid, serialize, journalRecords, pressKey, stageOf, layoutSelectOf, flushFrames, keyListenerCount, type GridHarness } from './grid-harness';
import { TerminalsGrid } from '../src/terminals/terminals-grid';

// The Tree Stage's rollback (design §5, Steps row P4b): `v2.treeStage` off gives back today's grid
// WHOLE — controls bar and layout selector included. The golden was recorded from the real grid,
// mounted through tests/grid-harness.ts, on origin/main before the tree stage existed (the commit
// that added it touches nothing in src/).
// git may check the fixture out with CRLF (core.autocrlf): compare the drawing, not the line endings.
const golden = fs.readFileSync('tests/fixtures/grid-today.golden.txt', 'utf8').replace(/\r\n/g, '\n');
const firstScene = golden.split('\n=====\n')[0]!.replace(/^### [^\n]*\n/, '');

const harnesses: GridHarness[] = [];
const mount = async (on: () => boolean, names = ['Alpha notes', 'Beta notes', 'Gamma notes']) => {
	const h = await mountGrid({ records: journalRecords(names), extra: { treeStage: on } });
	harnesses.push(h);
	return h;
};
// Mocks are restored even if a cleanup throws, so a spy can never carry its calls into the next test.
afterEach(async () => {
	try { while (harnesses.length) await harnesses.pop()!.cleanup(); }
	finally { vi.restoreAllMocks(); }
});

describe('v2.treeStage off — the grid byte for byte as it was', () => {
	it('with no setting at all, draws the recorded golden', async () => {
		expect(await drawScenes()).toBe(golden);
	});

	it('with the setting present and answering false — the app\'s off — draws it too', async () => {
		expect(await drawScenes({ treeStage: () => false })).toBe(golden);
	});

	it('on draws something different — so the off test above is testing something', async () => {
		expect(await drawScenes({ treeStage: () => true })).not.toBe(golden);
	});

	it('on hides the layout selector; off keeps it', async () => {
		const off = await mount(() => false);
		expect(layoutSelectOf(off)!.style.display ?? '').toBe('');
		const on = await mount(() => true);
		expect(layoutSelectOf(on)!.style.display).toBe('none');
		expect(stageOf(on).find((e) => e.has('cos-tree-pane'))).toBeDefined();
	});

	it('applies live: turned on and then off again, the grid draws its golden whole', async () => {
		let on = false;
		const h = await mount(() => on);
		expect(serialize(h.host)).toBe(firstScene);
		on = true; h.grid.treeStageChanged(); flushFrames();
		expect(serialize(h.host)).not.toBe(firstScene);
		expect(stageOf(h).findAll((e) => e.has('cos-term-tile')).every((t) => t.style.display === 'none')).toBe(true);
		on = false; h.grid.treeStageChanged(); flushFrames();
		expect(serialize(h.host)).toBe(firstScene);
	});
});

describe('the three unchanged keys — no regression, in either mode', () => {
	for (const mode of ['off', 'on'] as const) {
		it(`Alt+K opens or focuses the overseer (${mode})`, async () => {
			const spy = vi.spyOn(TerminalsGrid.prototype as unknown as { openKane: () => void }, 'openKane').mockImplementation(() => {});
			await mount(() => mode === 'on');
			expect(pressKey({ key: 'k', code: 'KeyK', altKey: true })).toBe(true);
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it(`Alt+J opens a new journal entry (${mode})`, async () => {
			const h = await mount(() => mode === 'on');
			const before = stageOf(h).findAll((e) => e.has('cos-journal-tile')).length;
			expect(pressKey({ key: 'j', code: 'KeyJ', altKey: true })).toBe(true);
			flushFrames();
			const tiles = stageOf(h).findAll((e) => e.has('cos-journal-tile'));
			expect(tiles).toHaveLength(before + 1);
			const fresh = tiles[tiles.length - 1]!;
			expect(fresh.text()).toContain('Journal 1');
			if (mode === 'off') expect(fresh.has('centered')).toBe(true);
			else {
				// "Unchanged; the entry opens in a slot" — shown, centred (the focused slot), every other journal hidden.
				expect(fresh.style.display ?? '').toBe('');
				expect(fresh.has('centered')).toBe(true);
				expect(tiles.slice(0, -1).every((t) => t.style.display === 'none')).toBe(true);
			}
		});

		it(`Alt+↑ / Alt+↓ are left for the workspace switcher (${mode})`, async () => {
			const h = await mount(() => mode === 'on');
			const before = serialize(h.host);
			expect(keyListenerCount()).toBe(1); // only the grid's own; app.ts's switcher is not mounted here
			expect(pressKey({ key: 'ArrowUp', altKey: true })).toBe(false);
			expect(pressKey({ key: 'ArrowDown', altKey: true })).toBe(false);
			flushFrames();
			expect(serialize(h.host)).toBe(before);
		});
	}
});

describe('the re-pointed keys, with the tree stage on', () => {
	const journalRow = (h: GridHarness, name: string) => stageOf(h).find((e) => e.has('cos-tree-extra-row') && e.textContent.startsWith(name))!;
	const openJournals = (h: GridHarness) => stageOf(h).find((e) => e.has('cos-tree-extra-head'))!.click();
	const tileEl = (h: GridHarness, name: string) => stageOf(h).find((e) => e.has('cos-term-tile') && e.text().includes(name))!;

	it('journals are not nodes: a Journals (n) row under the tree opens one in a slot', async () => {
		const h = await mount(() => true);
		expect(stageOf(h).findAll((e) => e.has('cos-tree-node'))).toHaveLength(0);
		const head = stageOf(h).find((e) => e.has('cos-tree-extra-head'))!;
		expect(head.textContent).toBe('▸ Journals (3)');
		openJournals(h);
		journalRow(h, 'Beta notes').click();
		expect(tileEl(h, 'Beta notes').style.display ?? '').toBe('');
		expect(tileEl(h, 'Alpha notes').style.display).toBe('none');
		expect(stageOf(h).find((e) => e.has('cos-slot-a'))!.text()).toContain('A · Beta notes');
	});

	it('a hidden session is still a node: it opens in a slot, keeps its hidden flag, and its – empties the slot', async () => {
		const h = await mountGrid({ records: journalRecords(['Alpha notes', 'Beta notes'], ['Beta notes']), extra: { treeStage: () => true } });
		harnesses.push(h);
		openJournals(h);
		journalRow(h, 'Beta notes').click();
		expect(tileEl(h, 'Beta notes').style.display ?? '').toBe('');
		const hiddenList = () => (h.grid as unknown as { hidden: Array<{ name: string }> }).hidden.map((t) => t.name);
		expect(hiddenList()).toEqual(['Beta notes']); // the flag is kept, and applies again if the setting goes off
		tileEl(h, 'Beta notes').find((e) => e.has('cos-term-hide'))!.click();
		expect(tileEl(h, 'Beta notes').style.display).toBe('none');
		expect(stageOf(h).findAll((e) => e.has('cos-slot-title')).map((e) => e.textContent)).not.toContain('A · Beta notes');
	});

	it('placing tiles in slots never re-parents them: every tile stays a child of the stage', async () => {
		const h = await mount(() => true);
		const tiles = stageOf(h).findAll((e) => e.has('cos-term-tile'));
		openJournals(h);
		journalRow(h, 'Alpha notes').click();
		journalRow(h, 'Beta notes').click();
		journalRow(h, 'Gamma notes').click();
		pressKey({ key: 'j', code: 'KeyJ', altKey: true });
		for (const t of stageOf(h).findAll((e) => e.has('cos-term-tile'))) expect(t.parent).toBe(stageOf(h));
		expect(tiles.every((t) => t.parent === stageOf(h))).toBe(true);
	});

	it('Alt+→ never re-arranges tiles; Alt+L pins the focused slot; Alt+[ ] and Alt+Backspace drive the slots', async () => {
		const h = await mount(() => true);
		openJournals(h);
		journalRow(h, 'Alpha notes').click();
		journalRow(h, 'Beta notes').click();
		tileEl(h, 'Alpha notes').click(); // focus A
		const rects = () => stageOf(h).findAll((e) => e.has('cos-term-tile')).map((t) => JSON.stringify(t.style));
		const before = rects();
		expect(pressKey({ key: 'ArrowRight', altKey: true })).toBe(true);
		expect(rects()).toEqual(before);
		expect(pressKey({ key: 'l', code: 'KeyL', altKey: true })).toBe(true);
		expect(stageOf(h).find((e) => e.has('cos-slot-a'))!.has('pinned')).toBe(true);
		expect(pressKey({ key: ']', code: 'BracketRight', altKey: true })).toBe(true);
		expect(stageOf(h).find((e) => e.has('cos-slot-b'))!.has('focused')).toBe(true);
		expect(pressKey({ key: 'Backspace', code: 'Backspace', altKey: true })).toBe(true);
		expect(stageOf(h).find((e) => e.has('cos-slot-b'))!.text()).toContain('B · empty');
		expect(tileEl(h, 'Beta notes').style.display).toBe('none');
	});

	it('a tile\'s own – hides it and empties its slot; the board can show it again into a slot', async () => {
		const h = await mount(() => true);
		openJournals(h);
		journalRow(h, 'Gamma notes').click();
		tileEl(h, 'Gamma notes').find((e) => e.has('cos-term-hide'))!.click();
		expect(stageOf(h).find((e) => e.has('cos-slot-a'))!.text()).toContain('A · empty');
		const show = h.host.find((e) => e.has('cos-reopen-btn') && e.textContent === 'Show')!;
		show.click();
		// The click rule picks the slot: both empty, A used just now (it was emptied), so B — least recently used.
		expect(stageOf(h).find((e) => e.has('cos-slot-b'))!.text()).toContain('B · Gamma notes');
		expect(tileEl(h, 'Gamma notes').style.display ?? '').toBe('');
	});
});
