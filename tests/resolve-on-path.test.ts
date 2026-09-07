import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveOnPath } from '../src/resolve-on-path';

// Real dirs with real files so statSync().isFile() behaves like production.
let dirA: string;
let dirB: string;

// POSIX PATH uses ':' as the separator, which collides with the 'C:' drive letter in
// Windows temp paths — so the POSIX-semantics cases can only be exercised on a POSIX host.
const posixOnly = it.skipIf(process.platform === 'win32');
// The positive win32 matches rely on a case-INSENSITIVE filesystem: the shim on disk is
// `claude.cmd` but PATHEXT (`.CMD`) makes the resolver stat `claude.CMD`. That matches on
// Windows/macOS but not on a case-sensitive Linux host (e.g. CI), so gate these on Windows.
const winOnly = it.skipIf(process.platform !== 'win32');
// PATHEXT is conventionally uppercase, so the resolved string carries that casing
// (…\claude.CMD) even though the file on disk is claude.cmd. Compare case-insensitively.
const sameFile = (a: string | null, b: string) => expect((a ?? '').toLowerCase()).toBe(b.toLowerCase());

beforeAll(() => {
	dirA = mkdtempSync(join(tmpdir(), 'rop-a-'));
	dirB = mkdtempSync(join(tmpdir(), 'rop-b-'));
	writeFileSync(join(dirA, 'claude.cmd'), '@echo off');       // npm's Windows shim
	writeFileSync(join(dirA, 'claude'), '#!/bin/sh');           // npm's POSIX shim (extensionless)
	writeFileSync(join(dirB, 'other.exe'), 'x');
});

afterAll(() => {
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
});

describe('resolveOnPath', () => {
	winOnly('finds the npm claude.cmd shim on Windows via PATHEXT', () => {
		const env = { PATH: [dirB, dirA].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
		sameFile(resolveOnPath('claude', env, 'win32'), join(dirA, 'claude.cmd'));
	});

	it('does NOT treat an extensionless file as a match on Windows (cmd /c cannot run it)', () => {
		// A dir holding ONLY the extensionless `claude` (no .cmd/.exe) — Windows must miss it.
		const bareOnly = mkdtempSync(join(tmpdir(), 'rop-bare-'));
		writeFileSync(join(bareOnly, 'claude'), '#!/bin/sh');
		try {
			expect(resolveOnPath('claude', { PATH: bareOnly, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
		} finally {
			rmSync(bareOnly, { recursive: true, force: true });
		}
	});

	it('returns null (win32) when the command is nowhere on PATH', () => {
		expect(resolveOnPath('claude', { PATH: dirB, PATHEXT: '.CMD' }, 'win32')).toBeNull();
	});

	it('returns null for an empty / missing PATH without throwing', () => {
		expect(resolveOnPath('claude', {}, 'win32')).toBeNull();
		expect(resolveOnPath('claude', { PATH: '' }, 'win32')).toBeNull();
	});

	winOnly('respects a lowercase Path key (Windows env casing)', () => {
		const env = { Path: dirA, PATHEXT: '.CMD' };
		sameFile(resolveOnPath('claude', env, 'win32'), join(dirA, 'claude.cmd'));
	});

	posixOnly('finds the extensionless claude on POSIX', () => {
		const env = { PATH: [dirB, dirA].join(':') };
		expect(resolveOnPath('claude', env, 'linux')).toBe(join(dirA, 'claude'));
	});

	posixOnly('returns null (POSIX) when the command is nowhere on PATH', () => {
		expect(resolveOnPath('claude', { PATH: dirB }, 'linux')).toBeNull();
	});
});
