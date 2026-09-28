/** Pure: the environment a spawned `claude` is allowed to inherit from this app.
 *
 *  Why this exists: when the app is launched from inside a Claude Code session (a Bash tool,
 *  a script it runs), the app process inherits THAT session's identity — CLAUDE_CODE_CHILD_SESSION,
 *  CLAUDE_CODE_SESSION_ID, the messaging socket and token, and so on. Passed through wholesale,
 *  every terminal the app spawned then believed it was a nested child of a session that had long
 *  since exited, and Claude Code turned transcript saving OFF for it: closing the tile lost the
 *  conversation for good, while the close confirm promised --continue would bring it back.
 *
 *  So the rule is prefix-based, not a name-by-name blocklist: every CLAUDE_CODE_* variable is
 *  dropped unless it is on KEEP below. Claude Code adds session markers over time; a blocklist
 *  would silently re-break the day it did. */

/** Session-identity variables Claude Code exports to its children that do NOT carry the
 *  CLAUDE_CODE_ prefix. The first three were in the app's own environment when it was launched
 *  from a Claude Code session; CLAUDE_EFFORT is what a session exports to its own tools. Each
 *  names or describes the PARENT session, never ours (a spawn's effort comes from --effort). */
const PARENT_SESSION_NAMES = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_JOB_DIR', 'CLAUDE_EFFORT']);

/** CLAUDE_CODE_* variables that are user configuration, not session identity, and that a
 *  spawned session genuinely needs if the user set them:
 *   - GIT_BASH_PATH: on Windows, where claude finds bash; without it the Bash tool can fail.
 *   - USE_BEDROCK / USE_VERTEX / USE_FOUNDRY: which API provider the user's account is on;
 *     dropping them would send a spawned session to the wrong backend. */
const KEEP = new Set([
	'CLAUDE_CODE_GIT_BASH_PATH',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY',
]);

/** True for a variable a spawned session must not inherit. Case-insensitive: Windows env
 *  names are, and a `Claude_Code_Child_Session` would be honoured all the same. */
export function isParentSessionVar(name: string): boolean {
	const n = name.toUpperCase();
	if (KEEP.has(n)) return false;
	return n.startsWith('CLAUDE_CODE_') || PARENT_SESSION_NAMES.has(n);
}

/** A copy of `env` with every parent-session variable removed. Never mutates its input;
 *  undefined values are dropped too, so the result is a plain string map a spawn accepts. */
export function sanitizeSessionEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined || isParentSessionVar(k)) continue;
		out[k] = v;
	}
	return out;
}
