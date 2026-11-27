// A render harness for the REAL ProjectPanel, with no DOM library: just enough of the dom-shim
// surface for it to draw into, and a serializer that turns the drawn tree into text so a test can
// compare one rendering with another byte for byte. The model is memory-panel-system.test.ts.
import { ProjectPanel, type ProjectPanelDeps } from '../src/ui/project-panel';
import type { ProjectViewInput } from '../src/ui/project-model';

export class FakeEl {
	children: FakeEl[] = [];
	parent: FakeEl | null = null;
	className = '';
	textContent = '';
	attrs = new Map<string, string>();
	style: Record<string, string> = {};
	scrollTop = 0;
	private handlers = new Map<string, Array<(e: unknown) => void>>();
	constructor(public tag: string) {}
	createEl(tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
		const c = new FakeEl(tag);
		if (o?.cls) c.className = o.cls;
		if (o?.text !== undefined) c.textContent = o.text;
		for (const [k, v] of Object.entries(o?.attr ?? {})) c.attrs.set(k, v);
		c.parent = this;
		this.children.push(c);
		return c;
	}
	createDiv(o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl { return this.createEl('div', o); }
	createSpan(o?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl { return this.createEl('span', o); }
	setAttr(k: string, v: string): FakeEl { this.attrs.set(k, v); return this; }
	toggleClass(c: string, on?: boolean): FakeEl {
		const set = new Set(this.className.split(' ').filter(Boolean));
		if (on ?? !set.has(c)) set.add(c); else set.delete(c);
		this.className = [...set].join(' ');
		return this;
	}
	empty(): void { this.children = []; }
	remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
	querySelector(): null { return null; }
	addEventListener(ev: string, fn: (e: unknown) => void): void {
		const l = this.handlers.get(ev) ?? [];
		l.push(fn);
		this.handlers.set(ev, l);
	}
	click(): void { for (const fn of this.handlers.get('click') ?? []) fn({ stopPropagation() {}, preventDefault() {} }); }
	all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
	text(): string { return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(' '); }
	find(pred: (e: FakeEl) => boolean): FakeEl | undefined { return this.all().find(pred); }
	has(cls: string): boolean { return this.className.split(' ').includes(cls); }
}

/** The drawn tree as text, one element per line, indented by depth: tag, class, attributes (sorted),
 *  inline style and text. Two renderings that serialize equal draw the same thing. */
export function serialize(e: FakeEl, depth = 0): string {
	const attrs = [...e.attrs].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
	const style = Object.keys(e.style).length ? ` style=${JSON.stringify(e.style)}` : '';
	const text = e.textContent ? ` ${JSON.stringify(e.textContent)}` : '';
	const line = `${'  '.repeat(depth)}<${e.tag}${e.className ? `.${e.className.split(' ').join('.')}` : ''}${attrs}${style}>${text}`;
	return [line, ...e.children.map((c) => serialize(c, depth + 1))].join('\n');
}

/** Open the real panel as a column over `input` and return what it drew. */
export function renderPanel(input: ProjectViewInput | null, extra: Partial<ProjectPanelDeps> = {}): { host: FakeEl; panel: ProjectPanel } {
	const g = globalThis as unknown as { window?: unknown };
	g.window ??= { setInterval: () => 1, clearInterval: () => {} };
	const host = new FakeEl('div');
	const panel = new ProjectPanel({ input: () => input, onRefresh: () => {}, onAccept: () => {}, onDecline: () => {}, ...extra });
	panel.open(host as unknown as HTMLElement, 'column');
	return { host, panel };
}
