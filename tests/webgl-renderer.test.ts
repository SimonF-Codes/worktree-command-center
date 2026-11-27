import { describe, it, expect } from 'vitest';
import { loadWebglRenderer, type RendererFallback } from '../src/terminals/webgl-renderer';

class FakeGl {
	lost: (() => void) | null = null;
	disposed = false;
	log: string[];
	constructor(log: string[]) { this.log = log; }
	onContextLoss(cb: () => void): void { this.lost = cb; }
	dispose(): void { this.disposed = true; this.log.push('dispose'); }
}

describe('loadWebglRenderer — a lost context is survivable and visible', () => {
	it('loads the addon and reports nothing while it works', () => {
		const log: string[] = [];
		const loaded: FakeGl[] = [];
		const gl = loadWebglRenderer(() => new FakeGl(log), (a) => loaded.push(a), (w) => log.push(`fallback:${w}`));
		expect(gl).not.toBeNull();
		expect(loaded).toEqual([gl]);
		expect(log).toEqual([]);
	});

	it('on context loss: disposes the addon FIRST, then reports — so the redraw runs on the DOM renderer', () => {
		const log: string[] = [];
		const gl = loadWebglRenderer(() => new FakeGl(log), () => {}, (w) => log.push(`fallback:${w}`))!;
		gl.lost!();
		expect(gl.disposed).toBe(true);
		expect(log).toEqual(['dispose', 'fallback:context-lost']);
	});

	it('a dispose that throws still reports the fallback', () => {
		const why: RendererFallback[] = [];
		const gl = loadWebglRenderer(() => { const g = new FakeGl([]); g.dispose = () => { throw new Error('gone'); }; return g; }, () => {}, (w) => why.push(w))!;
		gl.lost!();
		expect(why).toEqual(['context-lost']);
	});

	it('no context at all (constructor or load throws): null, and says unavailable', () => {
		const why: RendererFallback[] = [];
		expect(loadWebglRenderer(() => { throw new Error('no gpu'); }, () => {}, (w) => why.push(w))).toBeNull();
		expect(loadWebglRenderer(() => new FakeGl([]), () => { throw new Error('too many contexts'); }, (w) => why.push(w))).toBeNull();
		expect(why).toEqual(['unavailable', 'unavailable']);
	});
});
