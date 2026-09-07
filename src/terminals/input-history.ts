/** Shell-style up/down history for a single-line text input. Pure (no DOM), so it
 *  unit-tests cleanly. The owner records each submitted value and, on Arrow Up/Down,
 *  asks this for the string to place in the box.
 *
 *  Navigation model, like a shell: Up walks toward older entries; the first Up stashes
 *  whatever was already typed as a "draft" so Down can walk back to it. A method returns
 *  `null` when nothing should change (e.g. Up at the oldest entry, Down while not
 *  navigating) and a string — possibly `''` — when the box should be set to that value. */
export class InputHistory {
	private entries: string[] = [];
	private pos: number | null = null; // null = editing the live draft, not navigating history
	private draft = '';

	/** Record a submitted value (caller passes it trimmed). Empty strings and an immediate
	 *  duplicate of the newest entry are ignored; recording always resets navigation. */
	record(value: string): void {
		if (value && this.entries[this.entries.length - 1] !== value) this.entries.push(value);
		this.pos = null;
		this.draft = '';
	}

	/** Older entry, or null if there's nothing older to show. `current` is the box's text —
	 *  stashed as the draft on the first step so Down can return to it. */
	up(current: string): string | null {
		if (this.entries.length === 0) return null;
		if (this.pos === null) { this.draft = current; this.pos = this.entries.length - 1; return this.entries[this.pos]!; }
		if (this.pos > 0) { this.pos -= 1; return this.entries[this.pos]!; }
		return null; // already at the oldest entry
	}

	/** Newer entry; steps back to the stashed draft past the newest. Null when not navigating. */
	down(): string | null {
		if (this.pos === null) return null;
		if (this.pos < this.entries.length - 1) { this.pos += 1; return this.entries[this.pos]!; }
		this.pos = null; // stepped past the newest → restore the draft (may be '')
		return this.draft;
	}
}
