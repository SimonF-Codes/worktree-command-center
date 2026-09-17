import { formatBytes, type MemoryReport } from './session-memory';

/** The gauge behind the top-bar memory widget: one `MemoryReport` plus the size of the
 *  machine, in — a bar fraction, a label and a warning level, out.
 *
 *  Pure on purpose. The widget is a few divs around these four functions, so the thing worth
 *  getting right (when does it go red, and why) is testable without a renderer. */

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

export type GaugeLevel = 'ok' | 'warn' | 'crit';

/** Which condition raised the level, so the tooltip can say what to look at. */
export type GaugeReason = 'unattributed' | 'total' | null;

export interface GaugeState {
	/** 0..1 — how much of the machine's RAM the floor is holding. */
	fill: number;
	level: GaugeLevel;
	reason: GaugeReason;
	/** What sits beside the bar: "2.3/32 GB", with a ⚠ when something is wrong. */
	label: string;
	/** Hover text — the whole story, since the widget itself is four characters wide. */
	title: string;
}

const RANK: Record<GaugeLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** Total memory as a share of physical RAM, clamped to 0..1.
 *
 *  A raw byte count carries no judgement — 2.3 GB is noise on a 64 GB box and a third of a
 *  16 GB one — so the bar is denominated in the machine. An unknown or nonsensical denominator
 *  yields an empty bar rather than a NaN width. */
export function barFraction(totalBytes: number, ramBytes: number): number {
	if (!Number.isFinite(totalBytes) || !Number.isFinite(ramBytes) || ramBytes <= 0 || totalBytes <= 0) return 0;
	return Math.min(1, totalBytes / ramBytes);
}

/** Why the widget is coloured, if it is.
 *
 *  UNATTRIBUTED IS THE FIRST CONDITION and wins ties. It is the leak signal — memory this app
 *  is holding that no session on the floor accounts for — and it is the one a person can act
 *  on. Total is reported only when it is strictly worse. */
export function warningState(report: MemoryReport, ramBytes: number): { level: GaugeLevel; reason: GaugeReason } {
	const u = report.unattributed.rssBytes;
	const uLevel: GaugeLevel = u >= UNATTRIBUTED_CRIT_BYTES ? 'crit' : u >= UNATTRIBUTED_WARN_BYTES ? 'warn' : 'ok';
	const share = barFraction(report.totalBytes, ramBytes);
	const tLevel: GaugeLevel = share >= TOTAL_CRIT_SHARE ? 'crit' : share >= TOTAL_WARN_SHARE ? 'warn' : 'ok';

	if (uLevel !== 'ok' && RANK[uLevel] >= RANK[tLevel]) return { level: uLevel, reason: 'unattributed' };
	if (tLevel !== 'ok') return { level: tLevel, reason: 'total' };
	return { level: 'ok', reason: null };
}

/** The label beside the bar: what the floor holds over the size of the machine, "2.3/32 GB".
 *
 *  A ratio rather than a bare total, for the reason `barFraction` is denominated in the machine:
 *  2.3 GB is noise on a 64 GB box and a third of a 16 GB one, and the denominator is what makes
 *  the bar's fill legible as a number. Deliberately NOT `formatBytes` — that formatter serves
 *  the panel, where each figure stands alone; here both sides must share one unit or the ratio
 *  stops being one. The used side keeps a decimal because it moves; the machine is rounded
 *  because it does not, and "31.9 GB" is a worse name for a 32 GB machine than "32 GB". */
function ratioLabel(totalBytes: number, ramBytes: number): string {
	const used = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / GB : 0;
	// No denominator to divide by — fall back to the used figure alone rather than "2.3/0 GB".
	if (!Number.isFinite(ramBytes) || ramBytes <= 0) return `${used.toFixed(1)} GB`;
	return `${used.toFixed(1)}/${Math.round(ramBytes / GB)} GB`;
}

/** The whole widget state from one report. `ramBytes` is `os.totalmem()`, read once. */
export function gaugeFrom(report: MemoryReport, ramBytes: number): GaugeState {
	const { level, reason } = warningState(report, ramBytes);
	const fill = barFraction(report.totalBytes, ramBytes);
	const n = report.sessions.length;
	// The session count moves to the tooltip; the ⚠ stays, because it is the signal the widget
	// exists for and it is a glyph, not prose.
	const label = `${ratioLabel(report.totalBytes, ramBytes)}${level === 'ok' ? '' : ' ⚠'}`;

	const pct = Math.round(fill * 100);
	const bits = [
		`Session memory ${formatBytes(report.totalBytes)} of ${formatBytes(ramBytes)} (${pct}% of this machine)`,
		`${n} session${n === 1 ? '' : 's'}`,
		`unattributed ${formatBytes(report.unattributed.rssBytes)}`,
	];
	if (reason === 'unattributed') {
		bits.push('⚠ Unattributed memory is high — the app is holding processes no session claims. That is what a leak looks like.');
	} else if (reason === 'total') {
		bits.push('⚠ The floor is holding most of this machine. Close what you are not using.');
	}
	bits.push('Click for detail.');
	return { fill, level, reason, label, title: bits.join(' · ') };
}

/** What the widget shows before the first measurement lands, and on a platform with no process
 *  snapshot at all (anything but Windows). An empty bar and a dash, never a fake zero. */
export function gaugePending(): GaugeState {
	return { fill: 0, level: 'ok', reason: null, label: '—', title: 'Session memory — measuring…' };
}
