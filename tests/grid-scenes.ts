// The grid scenes the Tree Stage's off-state golden is recorded from (tests/tree-stage-off.test.ts).
// Each scene mounts the real grid through tests/grid-harness.ts, does one ordinary thing to it, and
// returns what was drawn. Recorded from origin/main BEFORE the tree stage existed; with
// `v2.treeStage` off the same scenes must draw the same bytes.
import type { GridDeps } from '../src/terminals/terminals-grid';
import { mountGrid, serialize, journalRecords, pressKey, stageOf, flushFrames, type GridHarness } from './grid-harness';

type Scene = { name: string; run: (h: GridHarness) => void | Promise<void> };

const tileNamed = (h: GridHarness, name: string) => stageOf(h).find((e) => e.has('cos-term-tile') && e.text().includes(name))!;

export const GRID_SCENES: Scene[] = [
	{ name: 'three journals, as restored', run: () => {} },
	{ name: 'a click centres the second', run: (h) => { tileNamed(h, 'Beta notes').click(); } },
	{ name: 'Alt+→ steps the spotlight', run: () => { pressKey({ key: 'ArrowRight', altKey: true }); } },
	{ name: 'Alt+J opens a journal entry', run: () => { pressKey({ key: 'j', code: 'KeyJ', altKey: true }); } },
	{ name: 'Alt+L locks the centred tile', run: (h) => { tileNamed(h, 'Gamma notes').click(); pressKey({ key: 'l', code: 'KeyL', altKey: true }); } },
	{ name: 'Alt+F2 jumps to the second tile', run: () => { pressKey({ key: 'F2', code: 'F2', altKey: true }); } },
	{ name: 'hiding a tile', run: (h) => { tileNamed(h, 'Alpha notes').find((e) => e.has('cos-term-hide'))!.click(); } },
];

/** Every scene, each on a fresh grid, joined into one text. */
export async function drawScenes(extra: Partial<GridDeps> = {}): Promise<string> {
	const out: string[] = [];
	for (const s of GRID_SCENES) {
		const h = await mountGrid({ records: journalRecords(['Alpha notes', 'Beta notes', 'Gamma notes']), extra });
		try {
			await s.run(h);
			flushFrames();
			out.push(`### ${s.name}\n${serialize(h.host)}`);
		} finally { h.cleanup(); }
	}
	return out.join('\n=====\n') + '\n';
}
