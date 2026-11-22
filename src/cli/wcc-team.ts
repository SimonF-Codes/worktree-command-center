import { main } from './team-cli';

// Entry point, bundled by esbuild.config.mjs into pty-sidecar/wcc-team.cjs, beside wcc-worktrees:
// the app runs it as a child process (D11), and so can anyone at a shell.
main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(e: unknown) => { process.stderr.write(`wcc-team: ${(e as Error)?.stack ?? String(e)}\n`); process.exitCode = 1; },
);
