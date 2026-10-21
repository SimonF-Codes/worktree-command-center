import { main } from './worktrees-cli';

// Entry point, bundled by esbuild.config.mjs into pty-sidecar/wcc-worktrees.cjs: the modules it
// drives are TypeScript and import each other, so a plain node script cannot reach them.
main(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(e: unknown) => { process.stderr.write(`wcc-worktrees: ${(e as Error)?.stack ?? String(e)}\n`); process.exitCode = 1; },
);
