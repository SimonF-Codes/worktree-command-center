import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { ghCandidates, ghRepoCreateArgs } from '../src/gh-cli';
import { windowsExe } from '../src/command-runner';

describe('ghCandidates', () => {
	const env = { LOCALAPPDATA: 'C:/Users/s/AppData/Local', ProgramFiles: 'C:/Program Files' };
	it("finds winget's per-package gh, which is not on PATH, before the MSI location", () => {
		const c = ghCandidates(env, 'win32', ['Git.Git_x', 'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe']);
		expect(c).toEqual([
			path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe', 'bin', 'gh.exe'),
			path.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe'),
		]);
	});
	it('offers nothing it cannot build a path for, and nothing off Windows (PATH covers POSIX)', () => {
		expect(ghCandidates({}, 'win32', ['GitHub.cli_x'])).toEqual([]);
		expect(ghCandidates(env, 'darwin', ['GitHub.cli_x'])).toEqual([]);
	});
});

describe('ghRepoCreateArgs', () => {
	it('creates, wires origin and pushes the initial commit in one call', () => {
		expect(ghRepoCreateArgs('my-app', 'C:/dev/my-app', 'private'))
			.toEqual(['repo', 'create', 'my-app', '--private', '--source', 'C:/dev/my-app', '--remote', 'origin', '--push']);
		expect(ghRepoCreateArgs('x', '/x', 'public')).toContain('--public');
	});
});

describe('windowsExe', () => {
	it('appends .exe to a bare name but never doubles it on an absolute exe path', () => {
		expect(windowsExe('git')).toBe('git.exe');
		expect(windowsExe('C:/gh/bin/gh.exe')).toBe('C:/gh/bin/gh.exe');
		expect(windowsExe('C:/gh/bin/GH.EXE')).toBe('C:/gh/bin/GH.EXE');
	});
});
