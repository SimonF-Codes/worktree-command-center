// Refuse to build if the version is inconsistent across the files that declare it.
//
// This exists because `package-lock.json` sat at 0.3.0 while `package.json` shipped 0.4.0 through
// 0.13.0 — ten releases. Nothing broke, which is exactly why nobody noticed: npm does not read the
// lockfile's `version` for resolution, so the drift is invisible until something *does* read it
// (a packager, an audit, a supply-chain tool, or a person trying to work out what a tree is).
//
// `npm version <v> --no-git-tag-version` updates both files and is the documented way to bump
// (docs/ci-cd.md). The drift comes from hand-editing one line instead, which is tempting because
// `npm version` also reformats nothing while a JSON round-trip would. This check makes the cheap
// path safe: edit by hand if you like, but the build will tell you what you missed.
//
// Runs in `npm run dist` before anything is built, so a bad version can never reach an installer.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));

/** Every place a version is declared, and how to reach it. Add a row when a new file declares one. */
function declarations() {
	const pkg = read('package.json');
	const lock = read('package-lock.json');
	return [
		{ where: 'package.json', path: 'version', value: pkg.version },
		{ where: 'package-lock.json', path: 'version', value: lock.version },
		{ where: 'package-lock.json', path: 'packages[""].version', value: lock.packages?.['']?.version },
	];
}

/** The problems with this set of declarations, as a list of human-readable strings. Pure. */
export function versionProblems(decls, changelog) {
	const problems = [];
	const expected = decls[0].value;

	if (!expected || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(expected)) {
		problems.push(`package.json version is "${expected}", which is not a semver version.`);
		return problems; // nothing else can be judged against it
	}

	for (const d of decls.slice(1)) {
		if (d.value === undefined) {
			problems.push(`${d.where} has no ${d.path}. Expected "${expected}".`);
		} else if (d.value !== expected) {
			problems.push(
				`${d.where} ${d.path} is "${d.value}" but package.json says "${expected}". ` +
					`Fix with: npm version ${expected} --no-git-tag-version --allow-same-version`,
			);
		}
	}

	// A release must be documented. `## Unreleased` does not count — release.yml asserts the same
	// thing on a pushed tag (docs/ci-cd.md), and finding out there means the tag is already public.
	if (changelog !== null && !new RegExp(`^## ${expected.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(changelog)) {
		problems.push(
			`CHANGELOG.md has no "## ${expected}" section. Promote the Unreleased notes before building a release.`,
		);
	}

	return problems;
}

function main() {
	// The changelog section is only required once the version is being shipped as a release. A
	// working build of an in-progress version should not be blocked by undocumented notes, so this
	// is skipped unless WCC_CHECK_CHANGELOG=1 or we are building from a clean release-shaped tree.
	const wantChangelog = process.env.WCC_CHECK_CHANGELOG === '1';
	const changelog = wantChangelog ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8') : null;

	const problems = versionProblems(declarations(), changelog);
	if (problems.length === 0) {
		console.log(`check-version: ok — ${declarations()[0].value} in every declaration`);
		return;
	}
	console.error('check-version: refusing to build.\n');
	for (const p of problems) console.error(`  - ${p}`);
	console.error('');
	process.exit(1);
}

// Run only when executed directly, so a test can import `versionProblems` without building.
const invokedDirectly =
	process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
