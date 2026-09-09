/** Heuristics over a terminal's recent on-screen output. Kept pure + standalone so they
 *  unit-test cleanly. */

/** Does the screen show an interactive selection menu (single- or multi-select) that the
 *  user is navigating with the arrow keys?
 *
 *  Used to AUTO-LOCK the grid: while such a menu is up, an Enter is toggling an option (not
 *  submitting a prompt) and a sibling going idle shouldn't steal focus — otherwise the tile
 *  switches out from under a multi-select before it can be finished.
 *
 *  Anchored on Claude Code's menu chrome — "↑/↓ to navigate", "Esc to cancel", "Enter to
 *  select/toggle/confirm" — which is TUI furniture that doesn't appear in normal output or
 *  in a message the user is typing, so it won't suppress ordinary prompt submits. */
export function looksLikeMenu(output: string): boolean {
	const t = String(output);
	// Arrow-key navigation hint, in either order ("↑/↓ to navigate" / "navigate with ↑↓").
	if (/[↑↓⬆⬇][^\n]{0,12}navigate/i.test(t)) return true;
	if (/navigate[^\n]{0,12}[↑↓⬆⬇]/i.test(t)) return true;
	// Cancel / select hints.
	if (/\besc(?:ape)?\b[^\n]{0,15}\bcancel\b/i.test(t)) return true;
	if (/\benter\b[^\n]{0,15}\b(?:select|toggle|confirm)\b/i.test(t)) return true;
	return false;
}

/** Best-effort sniff for a terminal that looks like it errored / failed. Fuzzy on purpose —
 *  it only nudges the attention queue, never blocks. */
export function looksErrored(output: string): boolean {
	const t = String(output);
	if (!t.trim()) return false;
	if (/\b(error|exception|fatal|failed|failure)\b/i.test(t)) return true;
	if (/traceback \(most recent call last\)/i.test(t)) return true;
	if (/\bcommand not found\b|is not recognized as/i.test(t)) return true;
	if (/\bexit(?:ed)?\b[^\n]{0,16}\bcode\s*[1-9]/i.test(t)) return true;
	if (/✗/.test(t)) return true;
	return false;
}

/** Is a turn actively RUNNING? Claude Code shows "esc to interrupt" in the status bar only
 *  while a turn is in flight — regardless of how it started (an in-app Enter, a cos-coord tell,
 *  or bypass-permission auto-continue). Used to keep the spotlight honest: a tile that's
 *  actively working is `thinking`, so when every tile is working the grid drops to equal size
 *  even if the per-tile idle flag drifted stale. */
export function looksBusy(output: string): boolean {
	return /esc\s+to\s+interrupt/i.test(String(output));
}

/** Collapse whitespace (including the newlines a wrapped line introduces) to single spaces, so a
 *  sent string can be found in on-screen output even where the terminal wrapped or re-flowed it. */
export function normalizeForMatch(s: string): string {
	return String(s).replace(/\s+/g, ' ').trim();
}

/** Strip ALL whitespace rather than collapsing it to a single space. Confirmed against the real
 *  Claude Code TUI (captured floor snapshots, 2026-09-09): a submitted line that's too long for
 *  one row hard-wraps at the column width, mid-word, with no space or hyphen at the break — just a
 *  continuation row indented two spaces:
 *
 *    > New task. Read C:\Users\...\worktree-command-center\.coordi
 *      nation\brain-2-0\briefs\mail-backend.md and do it.
 *
 *  normalizeForMatch's single-space collapse is wrong for exactly this case: joining those two rows
 *  with a space turns "coordi" + "nation" into "coordi nation" — a space that was never in the sent
 *  text ("coordination"). For any message long enough to wrap mid-word (most real task
 *  instructions, at typical terminal widths), that phantom space breaks the match — which is the
 *  false-negative regression this exists to fix, not a hypothetical. Stripping whitespace entirely
 *  makes the wrap point invisible on both sides of the comparison instead of guessing which kind of
 *  break it was. */
function stripWhitespace(s: string): string {
	return String(s).replace(/\s+/g, '');
}

/** Did a line we just typed actually land on screen, submitted or not? We don't try to tell those
 *  two apart (see TerminalTile.deliverLine) — we only need to rule out the one failure this exists
 *  for: the TUI was in a state (mid-/compact, still booting, …) that ate the keystrokes entirely,
 *  leaving no trace anywhere. Matches on a bounded prefix (not the whole string) so a long message
 *  that got line-wrapped still matches without needing the tail of a very long instruction, and an
 *  empty/whitespace-only line — which leaves no trace to look for by definition — is trivially
 *  "landed" rather than reported as a false failure. */
export function looksDelivered(recentOutput: string, sentText: string): boolean {
	const needle = stripWhitespace(sentText).slice(0, 80);
	if (!needle) return true;
	return stripWhitespace(recentOutput).includes(needle);
}
