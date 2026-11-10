import { describe, it, expect } from 'vitest';

// The real build guard. Imported rather than shelled out, so these are unit tests on the pure part.
const { versionProblems } = await import('../scripts/check-version.mjs');

/** The declaration list shape check-version builds from the two JSON files. */
function decls(pkg: string, lockRoot: string | undefined, lockPkg: string | undefined) {
	return [
		{ where: 'package.json', path: 'version', value: pkg },
		{ where: 'package-lock.json', path: 'version', value: lockRoot },
		{ where: 'package-lock.json', path: 'packages[""].version', value: lockPkg },
	];
}

describe('versionProblems', () => {
	it('is happy when every declaration agrees and the changelog has the section', () => {
		expect(versionProblems(decls('0.13.0', '0.13.0', '0.13.0'), '## 0.13.0 — 2026-11-02\n')).toEqual([]);
	});

	it('catches the real drift: a lockfile left behind at an older version', () => {
		// This is the exact state main was in for ten releases.
		const problems = versionProblems(decls('0.13.0', '0.3.0', '0.3.0'), null);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain('"0.3.0"');
		expect(problems[0]).toContain('"0.13.0"');
		// The message must carry the fix, not just the complaint.
		expect(problems[0]).toContain('npm version 0.13.0 --no-git-tag-version');
	});

	it('catches a lockfile whose root agrees but whose packages[""] does not', () => {
		const problems = versionProblems(decls('1.0.0', '1.0.0', '0.13.0'), null);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('packages[""].version');
	});

	it('reports a missing declaration rather than passing it', () => {
		const problems = versionProblems(decls('1.0.0', undefined, '1.0.0'), null);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('has no version');
	});

	it('rejects a non-semver version and does not then judge the others against it', () => {
		const problems = versionProblems(decls('not-a-version', '0.13.0', '0.13.0'), null);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('not a semver version');
	});

	it('accepts a prerelease, which is how a 1.0.0 run-up would be tagged', () => {
		expect(versionProblems(decls('1.0.0-rc.1', '1.0.0-rc.1', '1.0.0-rc.1'), null)).toEqual([]);
	});

	describe('changelog section', () => {
		it('is required when a changelog is supplied', () => {
			const problems = versionProblems(decls('1.0.0', '1.0.0', '1.0.0'), '## 0.13.0 — 2026-11-02\n');
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain('no "## 1.0.0" section');
		});

		it('does not accept Unreleased in place of the version', () => {
			const problems = versionProblems(decls('1.0.0', '1.0.0', '1.0.0'), '## Unreleased\n\nstuff\n');
			expect(problems).toHaveLength(1);
		});

		it('matches the real heading format, which carries an em-dash and a date', () => {
			expect(versionProblems(decls('1.0.0', '1.0.0', '1.0.0'), '# Changelog\n\n## 1.0.0 — 2026-12-01\n')).toEqual(
				[],
			);
		});

		it('does not match a different version that merely starts the same', () => {
			// "## 0.13.0" must not satisfy a check for 0.1.0 — the dots are escaped for this reason.
			const problems = versionProblems(decls('0.1.0', '0.1.0', '0.1.0'), '## 0.13.0 — 2026-11-02\n');
			expect(problems).toHaveLength(1);
		});

		it('is skipped entirely when no changelog is supplied', () => {
			expect(versionProblems(decls('9.9.9', '9.9.9', '9.9.9'), null)).toEqual([]);
		});
	});
});
