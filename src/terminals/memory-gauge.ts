import { formatBytes, type MemoryReport } from './session-memory';

/** The gauge behind the top-bar memory widget: one `MemoryReport`, the size of the machine and
 *  how much of it is free, in — three bar segments, a label and two warning levels, out.
 *
 *  Pure on purpose. The widget is a few divs around these functions, so the things worth
 *  getting right (when does it go red, and why; how big is each segment) are testable without
 *  a renderer. */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Unattributed memory that trips the warning.
 *
 *  Absolute bytes, NOT a share of the machine: unattributed memory is a leak signal rather
 *  than a measure of harm, and a leak is a leak on a 64 GB box too. On a healthy floor this
 *  number is tens of MB — transient `git` and coordination processes between polls — so 512 MB
 *  is well clear of the noise while still catching the usage-probe leak (3 GB/hour) about ten
 *  minutes in, against the hours it actually ran for. */
export const UNATTRIBUTED_WARN_BYTES = 512 * MB;
export const UNATTRIBUTED_CRIT_BYTES = 2 * GB;

/** Total session memory as a share of physical RAM. The second condition, and the weaker one:
 *  a high total is perfectly legitimate with twelve sessions open, which is exactly why warning
 *  on it alone would have stayed quiet right through the leak this widget exists to catch. */
export const TOTAL_WARN_SHARE = 0.6;
export const TOTAL_CRIT_SHARE = 0.8;

/** Free memory low enough that the FREE SEGMENT picks up a tint. A machine signal, kept
 *  strictly apart from the two above, which are app signals — see `pressure` on GaugeState.
 *
 *  Absolute bytes, not a share, because the question is "can I open another terminal" and a
 *  terminal costs what it costs: the floor measured 1.1 GB across 16 processes on 2026-09-17,
 *  a few hundred MB per session. So 2 GB is a handful of sessions' headroom and 1 GB is not
 *  reliably enough for one more plus the snapshot that measures it. A 64 GB box with 1 GB free
 *  is in the same trouble as a 16 GB one with 1 GB free, and a share would say otherwise. */
export const FREE_WARN_BYTES = 2 * GB;
export const FREE_CRIT_BYTES = 1 * GB;

export type GaugeLevel = 'ok' | 'warn' | 'crit';

/** Which condition raised the level, so the tooltip can say what to look at. */
export type GaugeReason = 'unattributed' | 'total' | null;

/** The machine cut three ways: what this app holds, what everything else holds, what is free.
 *
 *  THE THREE NUMBERS ARE NOT MEASURED THE SAME WAY, and nothing here pretends otherwise.
 *  `totalBytes` and `freeBytes` come from the OS and are authoritative. `appBytes` is a sum of
 *  process working sets, which OVER-COUNTS: shared pages — the Electron runtime, the DLLs
 *  behind sixteen processes — are counted once per process. `otherBytes` is the remainder, so
 *  it inherits that error in the opposite direction and can compute negative. It is clamped at
 *  zero and the seam is stated in the tooltip. A gauge that quietly reconciles two
 *  incompatible measurements is worse than one that admits the seam. */
export interface MemorySplit {
	/** What this app holds, as measured: a working-set sum, which reads slightly high. */
	appBytes: number;
	/** `total − free − app`, clamped at zero. Everything on the machine that is not us. */
	otherBytes: number;
	/** `os.freemem()`, re-read every poll. Authoritative. */
	freeBytes: number;
	/** `total − free`. What the OS says is in use, by anything at all. Authoritative. */
	usedBytes: number;
	/** `os.totalmem()`, read once. */
	totalBytes: number;
	/** False when free memory could not be read at all. The bar then degrades to the single
	 *  fill it was before this existed, rather than inventing a figure for the other two. */
	freeKnown: boolean;
	/** 0..1 each. They sum to exactly 1 whenever the machine size is known, and are all 0 when
	 *  it is not — an empty bar, never a NaN width. */
	appFrac: number;
	otherFrac: number;
	freeFrac: number;
}

export interface GaugeState {
	/** The three segments. The bar draws `appFrac` and `otherFrac`; free is the track. */
	split: MemorySplit;
	/** THIS APP's state — unattributed memory, then the app's own share. Never the machine's. */
	level: GaugeLevel;
	reason: GaugeReason;
	/** THE MACHINE's state, worn by the free segment alone. Independent of `level` on purpose. */
	pressure: GaugeLevel;
	/** What sits beside the bar: "1.1 GB · 18.2/31 used", with a ⚠ when something is wrong. */
	label: string;
	/** Hover text — the whole story, since the widget itself is four characters wide. */
	title: string;
}

const RANK: Record<GaugeLevel, number> = { ok: 0, warn: 1, crit: 2 };

const EMPTY_SPLIT: MemorySplit = {
	appBytes: 0, otherBytes: 0, freeBytes: 0, usedBytes: 0, totalBytes: 0,
	freeKnown: false, appFrac: 0, otherFrac: 0, freeFrac: 0,
};

/** Total memory as a share of physical RAM, clamped to 0..1.
 *
 *  A raw byte count carries no judgement — 2.3 GB is noise on a 64 GB box and a third of a
 *  16 GB one — so the bar is denominated in the machine. An unknown or nonsensical denominator
 *  yields an empty bar rather than a NaN width. */
export function barFraction(totalBytes: number, ramBytes: number): number {
	if (!Number.isFinite(totalBytes) || !Number.isFinite(ramBytes) || ramBytes <= 0 || totalBytes <= 0) return 0;
	return Math.min(1, totalBytes / ramBytes);
}

/** Cut the machine three ways. See `MemorySplit` for why the inputs do not agree.
 *
 *  THE PATHOLOGICAL CASE, and the reason this is a function rather than three divisions in the
 *  widget: the app's working-set sum can exceed what the OS says is in use at all. Free and
 *  total win, because they are the authoritative pair — the app segment is drawn no wider than
 *  the measured used space, `other` falls to zero, and the three fractions still sum to 1. The
 *  *label* keeps reporting the app's figure as measured; only the geometry is reconciled, and
 *  the tooltip says which number is the soft one. */
export function splitMemory(totalBytes: number, freeBytes: number, appBytes: number): MemorySplit {
	const measured = Number.isFinite(appBytes) && appBytes > 0 ? appBytes : 0;
	if (!Number.isFinite(totalBytes) || totalBytes <= 0) return { ...EMPTY_SPLIT, appBytes: measured };
	const total = totalBytes;
	const app = Math.min(measured, total);

	// No readable free figure: fall back to the gauge as it was — the app's share filled, the
	// rest empty track, no `other` segment and no pressure tint. Never a full-looking machine,
	// which is what treating an unknown free as zero would draw.
	if (!Number.isFinite(freeBytes) || freeBytes < 0 || freeBytes > total) {
		const frac = app / total;
		return {
			appBytes: app, otherBytes: 0, freeBytes: total - app, usedBytes: app, totalBytes: total,
			freeKnown: false, appFrac: frac, otherFrac: 0, freeFrac: 1 - frac,
		};
	}

	const free = freeBytes;
	const used = total - free;
	// The app can claim more than the OS says is in use; the OS is right, so the drawn segment
	// is capped and `other` is whatever is left of the used space.
	const drawn = Math.min(app, used);
	const other = used - drawn;
	return {
		appBytes: app, otherBytes: other, freeBytes: free, usedBytes: used, totalBytes: total,
		freeKnown: true,
		appFrac: drawn / total, otherFrac: other / total, freeFrac: free / total,
	};
}

/** Why the widget is coloured, if it is.
 *
 *  UNATTRIBUTED IS THE FIRST CONDITION and wins ties. It is the leak signal — memory this app
 *  is holding that no session on the floor accounts for — and it is the one a person can act
 *  on. Total is reported only when it is strictly worse.
 *
 *  Free memory is deliberately NOT a condition here. See `machinePressure`. */
export function warningState(report: MemoryReport, ramBytes: number): { level: GaugeLevel; reason: GaugeReason } {
	const u = report.unattributed.rssBytes;
	const uLevel: GaugeLevel = u >= UNATTRIBUTED_CRIT_BYTES ? 'crit' : u >= UNATTRIBUTED_WARN_BYTES ? 'warn' : 'ok';
	const share = barFraction(report.totalBytes, ramBytes);
	const tLevel: GaugeLevel = share >= TOTAL_CRIT_SHARE ? 'crit' : share >= TOTAL_WARN_SHARE ? 'warn' : 'ok';

	if (uLevel !== 'ok' && RANK[uLevel] >= RANK[tLevel]) return { level: uLevel, reason: 'unattributed' };
	if (tLevel !== 'ok') return { level: tLevel, reason: 'total' };
	return { level: 'ok', reason: null };
}

/** How close the MACHINE is to full, reported on the free segment alone.
 *
 *  Kept out of `warningState` on purpose. The gauge's warning colour has one meaning —
 *  *something about this app needs attention* — and it must not go red because Chrome filled
 *  the machine. The one row that must be trusted cannot start crying wolf about things nobody
 *  can fix from here; that is the same failure the unattributed row was designed to avoid.
 *  Machine pressure is real and worth showing, so it tints the part of the bar it describes. */
export function machinePressure(split: MemorySplit): GaugeLevel {
	if (!split.freeKnown) return 'ok';
	if (split.freeBytes <= FREE_CRIT_BYTES) return 'crit';
	if (split.freeBytes <= FREE_WARN_BYTES) return 'warn';
	return 'ok';
}

/** The label beside the bar: `1.1 GB · 18.2/31 used`.
 *
 *  THE APP'S OWN FIGURE LEADS. It is the actionable number and the reason this widget exists;
 *  machine pressure is context for it, not the headline. Deliberately NOT `formatBytes` —
 *  that formatter serves the panel, where each figure stands alone; here every number shares
 *  one unit or the ratio stops being one. The moving figures keep a decimal; the machine is
 *  rounded because it does not move, and "31.9 GB" is a worse name for a 32 GB machine than
 *  "32 GB".
 *
 *  With no readable free figure this falls back to the ratio the gauge carried before —
 *  `1.1/31 GB`, the app over the machine — because there is nothing honest to say about the
 *  other two quantities. */
export function splitLabel(split: MemorySplit): string {
	const app = split.appBytes / GB;
	// No denominator to divide by — the used figure alone rather than "1.1/0 GB".
	if (split.totalBytes <= 0) return `${app.toFixed(1)} GB`;
	const machine = Math.round(split.totalBytes / GB);
	if (!split.freeKnown) return `${app.toFixed(1)}/${machine} GB`;
	return `${app.toFixed(1)} GB · ${(split.usedBytes / GB).toFixed(1)}/${machine} used`;
}

/** The whole widget state from one report.
 *
 *  `ramBytes` is `os.totalmem()`, read once — it does not change. `freeBytes` is
 *  `os.freemem()`, RE-READ EVERY POLL, which is the part that makes this gauge honest: the
 *  machine's free memory is the fastest-moving of the three numbers and the one the old
 *  single-fill bar silently assumed was everything it was not drawing. Neither call spawns a
 *  process, so this costs nothing the tracker has to budget for. */
export function gaugeFrom(report: MemoryReport, ramBytes: number, freeBytes: number): GaugeState {
	const { level, reason } = warningState(report, ramBytes);
	const split = splitMemory(ramBytes, freeBytes, report.totalBytes);
	const pressure = machinePressure(split);
	const n = report.sessions.length;
	// The session count moves to the tooltip; the ⚠ stays, because it is the signal the widget
	// exists for and it is a glyph, not prose.
	const label = `${splitLabel(split)}${level === 'ok' ? '' : ' ⚠'}`;

	const pct = Math.round(barFraction(report.totalBytes, ramBytes) * 100);
	const bits = [
		`This app ${formatBytes(report.totalBytes)} of ${formatBytes(ramBytes)} (${pct}% of this machine)`,
		`${n} session${n === 1 ? '' : 's'}`,
		`unattributed ${formatBytes(report.unattributed.rssBytes)}`,
	];
	if (split.freeKnown) {
		bits.push(`other processes ${formatBytes(split.otherBytes)}`, `free ${formatBytes(split.freeBytes)}`);
	}
	if (reason === 'unattributed') {
		bits.push('⚠ Unattributed memory is high — the app is holding processes no session claims. That is what a leak looks like.');
	} else if (reason === 'total') {
		bits.push('⚠ The floor is holding most of this machine. Close what you are not using.');
	}
	// Said plainly, and said even when nothing is wrong: the app's number is the one a person
	// will compare over time, so they are owed the direction of its error.
	bits.push('This app\'s figure is a sum of process working sets, so pages shared between its processes are counted once each — it reads slightly high, and "other" is the remainder.');
	if (pressure !== 'ok') {
		bits.push(`⚠ The MACHINE is nearly full — ${formatBytes(split.freeBytes)} free. That is everything running, not this app.`);
	}
	bits.push('Click for detail.');
	return { split, level, reason, pressure, label, title: bits.join(' · ') };
}

/** The panel's total row, which carried the same ambiguity as the bar: "X total" said nothing
 *  about whether the other 30 GB were free or spoken for. Same three quantities, same order,
 *  in the panel's own units — each figure stands alone there, so `formatBytes` is right here
 *  where it is wrong in the label.
 *
 *  Lives beside the split rather than in the panel for the reason the label does: the strings
 *  are the part worth pinning in a test, and the panel is a renderer. */
export function splitDetail(split: MemorySplit): { main: string; sub: string } {
	const main = `${formatBytes(split.appBytes)} this app`;
	if (!split.freeKnown) return { main, sub: `of ${formatBytes(split.totalBytes)} on this machine` };
	return {
		main,
		sub: `${formatBytes(split.otherBytes)} other · ${formatBytes(split.freeBytes)} free of ${formatBytes(split.totalBytes)}`,
	};
}

/** What the widget shows before the first measurement lands, and on a platform with no process
 *  snapshot at all (anything but Windows). An empty bar and a dash, never a fake zero. */
export function gaugePending(): GaugeState {
	return { split: EMPTY_SPLIT, level: 'ok', reason: null, pressure: 'ok', label: '—', title: 'Session memory — measuring…' };
}
