/** Resolve a bare command name against PATH the way the OS would when spawning it,
 *  returning the first matching executable file (or null if none is found).
 *
 *  This mirrors how the pty sidecar actually launches `claude` — via `cmd /c claude`
 *  on Windows (which resolves through PATHEXT, so npm's `claude.cmd` shim counts) and
 *  directly on POSIX — so a null result means a real spawn would genuinely fail with
 *  "not found", not merely that a specific filename is absent.
 *
 *  Pure: only `fs`/`path`, no Electron or node-pty, so it unit-tests cleanly and can be
 *  imported from both the main process and (in tests) plain Node. */
import * as fs from 'fs';
import * as path from 'path';

export function resolveOnPath(
	cmd: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	// Windows env var names are case-insensitive; Node preserves whatever case was set.
	const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
	const isWin = platform === 'win32';
	const dirs = pathVar.split(isWin ? ';' : ':').filter(Boolean);
	const hasExt = path.extname(cmd) !== '';
	// On Windows a bare name resolves through PATHEXT (`.CMD` catches npm's claude.cmd
	// shim); a name that already carries an extension is matched as-is. On POSIX the name
	// is used verbatim. Note: an extensionless file on Windows is intentionally NOT a match
	// — `cmd /c` won't execute it, so reporting it as found would be a false positive.
	const exts = isWin
		? (hasExt ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
		: [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, cmd + ext);
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch { /* not on this dir — keep looking */ }
		}
	}
	return null;
}
