import { defineConfig, configDefaults } from 'vitest/config';

// Worktrees are created inside the repo (<repo>/.claude-worktrees/<slug>), and vitest does not
// read git's ignores — without this, a run in the primary checkout would also collect every
// worktree's copy of the suite.
// The timeouts are global and deliberately generous. Fifteen of these files shell out to REAL
// git — worktree add, merge, prune, lease contention — in temp directories, and under a full
// parallel run on a loaded machine one `git worktree add` can exceed vitest's 5s default. That
// produced false failures on three separate days in three different files, each passing on its
// own. A suite that cries wolf stops being the gate every merge is judged against, which costs
// more than the slow test it was guarding against.
//
// Raising it costs close to nothing: a timeout exists to catch a hang, and a hung pure-logic
// test is just as hung at 60s as at 5s — the only difference is how long the report takes.
// Three files were patched individually before this (move-repo-io, prune-worktrees-io,
// claims-collision); their own `vi.setConfig` calls are now redundant but harmless.
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, '**/.claude-worktrees/**'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
