// A live tile draws through xterm's WebglAddon, loaded after open(). Two ways it can fail: no
// context at all (no GPU, or too many contexts already), or a context lost later (a driver reset,
// the browser reclaiming contexts). Either way the tile must keep drawing — xterm falls back to its
// DOM renderer once the addon is disposed — and the failure must be visible, not a blank tile.
//
// Tree Stage P4b places tiles in Side Panel slots. It never re-parents one (tree-stage.ts `place`
// moves a tile only by setRect and hides it only by display:none, the two operations the grid
// already makes), but a lost context is survivable here whatever causes it. Whether a WebGL tile
// still draws after being placed at slot sizes was NOT checked in the running app.
//
// Pure apart from the callbacks: no DOM, no xterm import, so it can be tested with fakes.

export interface GlAddonLike {
	onContextLoss(cb: () => void): unknown;
	dispose(): void;
}

export type RendererFallback = 'unavailable' | 'context-lost';

/** Load a WebGL renderer, or say why the DOM renderer is drawing instead. On a context loss the
 *  addon is disposed FIRST — so xterm has already switched back to its DOM renderer when
 *  `onFallback` runs, and a refresh there draws instead of leaving the canvas blank. Returns the
 *  loaded addon, or null when none could be loaded. */
export function loadWebglRenderer<A extends GlAddonLike>(make: () => A, load: (addon: A) => void, onFallback: (why: RendererFallback) => void): A | null {
	let addon: A;
	try {
		addon = make();
		addon.onContextLoss(() => {
			try { addon.dispose(); } catch { /* already gone */ }
			onFallback('context-lost');
		});
		load(addon);
	} catch {
		onFallback('unavailable');
		return null;
	}
	return addon;
}
