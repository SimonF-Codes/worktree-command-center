import { defineConfig, configDefaults } from 'vitest/config';

// Worktrees are created inside the repo (<repo>/.claude-worktrees/<slug>), and vitest does not
// read git's ignores — without this, a run in the primary checkout would also collect every
// worktree's copy of the suite.
export default defineConfig({
	test: { exclude: [...configDefaults.exclude, '**/.claude-worktrees/**'] },
});
