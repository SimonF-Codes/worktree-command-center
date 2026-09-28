import { describe, it, expect } from 'vitest';
import { sanitizeSessionEnv, isParentSessionVar } from '../src/terminals/session-env';

// The app's real environment on 2026-09-27, launched from inside a Claude Code session
// (plus CLAUDE_EFFORT, which a session exports to its own tools).
const INHERITED = {
	CLAUDECODE: '1',
	CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
	CLAUDE_CODE_CHILD_SESSION: '1',
	CLAUDE_CODE_ENTRYPOINT: 'cli',
	CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-ad8b',
	CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
	CLAUDE_CODE_SESSION_ATTENDED: '0',
	CLAUDE_CODE_SESSION_ID: '40d8f9ff-fcbf-4462-a24b-edaf595f7669',
	CLAUDE_JOB_DIR: 'C:\\Users\\x\\.claude\\jobs\\40d8f9ff',
	CLAUDE_PID: '35248',
	CLAUDE_EFFORT: 'medium',
};

describe('sanitizeSessionEnv', () => {
	it('removes every parent-session marker', () => {
		const out = sanitizeSessionEnv({ ...INHERITED, PATH: 'C:\\bin' });
		expect(out).toEqual({ PATH: 'C:\\bin' });
	});

	it('removes the four markers that disable transcript saving, by name', () => {
		const out = sanitizeSessionEnv(INHERITED);
		for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SESSION_ATTENDED']) {
			expect(out).not.toHaveProperty(k);
		}
	});

	it('removes a CLAUDE_CODE_* marker it has never heard of — prefix, not blocklist', () => {
		expect(sanitizeSessionEnv({ CLAUDE_CODE_SOME_FUTURE_MARKER: 'x' })).toEqual({});
	});

	it('matches names case-insensitively, as Windows does', () => {
		expect(sanitizeSessionEnv({ Claude_Code_Child_Session: '1', ClaudeCode: '1' })).toEqual({});
	});

	it('keeps a keep-listed CLAUDE_CODE_* variable', () => {
		const env = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_CHILD_SESSION: '1' };
		expect(sanitizeSessionEnv(env)).toEqual({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_USE_BEDROCK: '1' });
	});

	it("removes the overseer's cos-coord identity, so a worker is never god", () => {
		const env = { COS_ROLE: 'god', COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Alpha', COS_COORD_DIR: 'd', PATH: 'p' };
		expect(sanitizeSessionEnv(env)).toEqual({ PATH: 'p' });
	});

	it('changes nothing in an env without markers', () => {
		const env = { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\x', CLAUDE_CONFIG_DIR: 'C:\\cfg', ANTHROPIC_API_KEY: 'k', COSTS: '1' };
		expect(sanitizeSessionEnv(env)).toEqual(env);
	});

	it('does not mutate its input, and drops undefined values', () => {
		const env: Record<string, string | undefined> = { ...INHERITED, HOME: undefined, PATH: 'p' };
		const before = { ...env };
		expect(sanitizeSessionEnv(env)).toEqual({ PATH: 'p' });
		expect(env).toEqual(before);
	});
});

describe('isParentSessionVar', () => {
	it('does not catch lookalikes outside the prefix', () => {
		expect(isParentSessionVar('CLAUDE_CONFIG_DIR')).toBe(false);
		expect(isParentSessionVar('MY_CLAUDE_CODE_THING')).toBe(false);
		expect(isParentSessionVar('CLAUDE_CODEX')).toBe(false);
	});
});
