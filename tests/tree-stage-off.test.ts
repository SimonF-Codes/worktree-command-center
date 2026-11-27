import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { drawScenes } from './grid-scenes';

// The Tree Stage's rollback (design §5, Steps row P4b): `v2.treeStage` off gives back today's grid
// WHOLE — controls bar and layout selector included. The golden was recorded from the real grid,
// mounted through tests/grid-harness.ts, on origin/main before the tree stage existed.
describe('the grid as it is today', () => {
	// git may check the fixture out with CRLF (core.autocrlf): compare the drawing, not the line endings.
	const golden = fs.readFileSync('tests/fixtures/grid-today.golden.txt', 'utf8').replace(/\r\n/g, '\n');

	it('draws the recorded golden, byte for byte', async () => {
		expect(await drawScenes()).toBe(golden);
	});
});
