import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateConnectorRequest, parseConnectorRequest, receiptFilename } from '../src/terminals/connectors';
import { buildFloorState, renderFloorState } from '../src/terminals/floor-state';
import { sanitizeSessionEnv } from '../src/terminals/session-env';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../pty-sidecar/wcc-client-core.cjs');
const CLI = path.join(__dirname, '..', 'pty-sidecar', 'wcc-client.cjs');

// The client must not see the outer shell's WCC_* (or the COS_* a session started by the app has).
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(sanitizeSessionEnv(process.env)).filter(([k]) => !k.startsWith('WCC_')),
);

describe('wcc-client-core: arguments and configuration', () => {
	it('splits command, positionals and flags', () => {
		expect(core.parseArgs(['spawn', 'app', '--task', 'do X', '--effort', 'high', '--json'])).toEqual({
			ok: true, command: 'spawn', args: ['app'], flags: { task: 'do X', effort: 'high', json: true },
		});
	});

	it('refuses an unknown flag instead of ignoring it', () => {
		expect(core.parseArgs(['spawn', 'app', '--efort', 'high'])).toEqual({ ok: false, reason: 'unknown flag --efort' });
	});

	it('treats everything after -- as positional', () => {
		expect(core.parseArgs(['tell', 'ax', '--json', '--', '--not-a-flag', 'x'])).toEqual({ ok: true, command: 'tell', args: ['ax', '--not-a-flag', 'x'], flags: { json: true } });
	});

	it('refuses a value flag with no value', () => {
		expect(core.parseArgs(['tell', 'x', '--connector'])).toEqual({ ok: false, reason: '--connector needs a value' });
	});

	it('takes the coord dir from the flag before the env', () => {
		expect(core.resolveCoordDir({ 'coord-dir': '/a' }, { WCC_COORD_DIR: '/b' }, 'linux', '/h')).toEqual({ ok: true, dir: '/a' });
		expect(core.resolveCoordDir({}, { WCC_COORD_DIR: '/b' }, 'linux', '/h')).toEqual({ ok: true, dir: '/b' });
	});

	it('derives the coord dir from a workspace id under each platform\'s userData', () => {
		expect(core.resolveCoordDir({ workspace: 'default' }, { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'))
			.toEqual({ ok: true, dir: 'C:\\Users\\u\\AppData\\Roaming\\worktree-command-center\\.coordination\\default' });
		expect(core.resolveCoordDir({}, { WCC_WORKSPACE: 'w2' }, 'darwin', '/Users/u'))
			.toEqual({ ok: true, dir: '/Users/u/Library/Application Support/worktree-command-center/.coordination/w2' });
		expect(core.resolveCoordDir({ workspace: 'w' }, { WCC_USER_DATA: '/x' }, 'linux', '/h'))
			.toEqual({ ok: true, dir: '/x/.coordination/w' });
	});

	it('has no silent default workspace', () => {
		expect(core.resolveCoordDir({}, {}, 'win32', 'C:\\h').ok).toBe(false);
	});

	it('requires a slug connector id', () => {
		expect(core.resolveConnector({}, { WCC_CONNECTOR: 'brain-2-0' })).toEqual({ ok: true, id: 'brain-2-0' });
		expect(core.resolveConnector({}, {}).ok).toBe(false);
		expect(core.resolveConnector({ connector: 'Brain 2' }, {}).ok).toBe(false);
	});

	it('reads the wait from flag or env, falling back on garbage', () => {
		expect(core.resolveWaitMs({ 'wait-ms': '500' }, {})).toBe(500);
		expect(core.resolveWaitMs({}, { WCC_WAIT_MS: '0' })).toBe(0);
		expect(core.resolveWaitMs({}, { WCC_WAIT_MS: 'soon' })).toBe(core.DEFAULT_WAIT_MS);
	});
});

describe('wcc-client-core: the envelopes it builds are the ones the app accepts', () => {
	const opts = { connectorId: 'brain-2-0', registeredConnectorIds: ['brain-2-0'], knownRepoNames: ['app'], liveTerminals: [{ name: 'ax-a1', isJournal: false }] };

	it('spawn', () => {
		const body = core.buildSpawnRequest({ id: 'r1', connector: 'brain-2-0', sentMs: 1, repo: 'app', task: 'do X', effort: 'high' });
		expect(body).toEqual({ v: 1, id: 'r1', connector: 'brain-2-0', sentMs: 1, kind: 'spawn', repo: 'app', base: null, task: 'do X', model: null, effort: 'high', name: null });
		expect(parseConnectorRequest(JSON.stringify(body)).ok).toBe(true);
		expect(evaluateConnectorRequest(JSON.stringify(body), opts).status).toBe('accepted');
	});

	it('tell', () => {
		const body = core.buildTellRequest({ id: 'r2', connector: 'brain-2-0', sentMs: 1, terminal: 'ax-a1', message: 'hi' });
		expect(evaluateConnectorRequest(JSON.stringify(body), opts).status).toBe('accepted');
	});

	it('names receipts exactly as the app does', () => {
		for (const id of ['abc-123_X', 'a/../b', 'é', '']) expect(core.receiptFilename(id)).toBe(receiptFilename(id));
	});

	it('reads only a well-formed accepted receipt as success', () => {
		expect(core.interpretReceipt({ v: 1, id: 'x', status: 'accepted', terminalName: 't', handledMs: 1 })).toEqual({ ok: true, terminalName: 't' });
		expect(core.interpretReceipt({ v: 1, id: 'x', status: 'rejected', reason: 'nope', handledMs: 1 })).toEqual({ ok: false, reason: 'nope' });
		expect(core.interpretReceipt({ status: 'weird' }).ok).toBe(false);
		expect(core.interpretReceipt(null).ok).toBe(false);
	});
});

describe('wcc-client-core: the floor', () => {
	const state = buildFloorState({
		workspaceId: 'default', ts: 10_000, intervalMs: 4000, scannedAt: null, worktrees: [],
		sessions: [
			{ id: 1, name: 'ax-a1', kind: 'terminal', repo: 'app', branch: 'wt/main-1', worktreePath: '/w', busy: false, hidden: true, snapshotFile: '1-ax-a1.md' },
			{ id: 0, name: 'Kane', kind: 'god', repo: null, branch: null, worktreePath: null, busy: null, hidden: false, snapshotFile: null },
		],
	});

	it('formats the app\'s own state file', () => {
		expect(core.formatFloor(state, 12_000)).toBe([
			'floor default — snapshot 2s old',
			'  ax-a1  app · wt/main-1  idle  (hidden)',
			'  Kane  god  -  (not tellable)',
		].join('\n'));
	});

	it('calls a snapshot stale after three missed intervals', () => {
		expect(core.isStale(state, 10_000 + 12_000)).toBe(false);
		expect(core.isStale(state, 10_000 + 12_001)).toBe(true);
	});
});

// ── the CLI end to end, with this test playing the app's part through the app's own decision ──

let coordDir: string;
beforeEach(() => { coordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-')); });

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile('node', [CLI, ...args], { env: { ...BASE_ENV, WCC_COORD_DIR: coordDir, WCC_CONNECTOR: 'brain-2-0', ...env }, encoding: 'utf8' },
			(e, out, err) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out, err }));
	});
}

/** Wait for one request to land, then drain it the way TerminalsGrid.drainConnectorRequests
 *  does (rename into .done/) and hand back its text. */
async function takeRequest(connector = 'brain-2-0'): Promise<string> {
	const reqDir = path.join(coordDir, 'connectors', connector, 'requests');
	const start = Date.now();
	for (;;) {
		const files = fs.existsSync(reqDir) ? fs.readdirSync(reqDir).filter((f) => f.endsWith('.json')) : [];
		if (files.length) {
			fs.mkdirSync(path.join(reqDir, '.done'), { recursive: true });
			const text = fs.readFileSync(path.join(reqDir, files[0]), 'utf8');
			fs.renameSync(path.join(reqDir, files[0]), path.join(reqDir, '.done', files[0]));
			return text;
		}
		if (Date.now() - start > 5000) throw new Error('no request arrived');
		await new Promise((r) => setTimeout(r, 20));
	}
}

function writeReceipt(connector: string, receipt: Record<string, unknown>): void {
	const dir = path.join(coordDir, 'connectors', connector, 'receipts');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, receiptFilename(String(receipt.id))), JSON.stringify(receipt));
}

/** The app's half: evaluate with the real decision function and file its receipt. */
async function playApp(registered: string[], connector = 'brain-2-0'): Promise<void> {
	const text = await takeRequest(connector);
	const o = evaluateConnectorRequest(text, { connectorId: connector, registeredConnectorIds: registered, knownRepoNames: ['app'], liveTerminals: [{ name: 'ax-a1', isJournal: false }, { name: 'notes', isJournal: true }] });
	if (o.status === 'rejected') writeReceipt(connector, { v: 1, id: o.id, status: 'rejected', reason: o.reason, handledMs: Date.now() });
	else writeReceipt(connector, { v: 1, id: o.id, status: 'accepted', terminalName: o.request.kind === 'tell' ? o.request.terminal : 'ax-new', handledMs: Date.now() });
}

describe('wcc-client CLI', () => {
	it('spawn: blocks on the receipt, prints the new terminal, exits 0, and cleans up the receipt', async () => {
		const [r] = await Promise.all([runCli(['spawn', 'app', '--task', 'do X']), playApp(['brain-2-0'])]);
		expect(r).toMatchObject({ code: 0, out: 'ax-new\n' });
		expect(fs.readdirSync(path.join(coordDir, 'connectors', 'brain-2-0', 'receipts'))).toEqual([]);
	});

	it('tell: resolves case-insensitively through the app and prints the exact name', async () => {
		const [r] = await Promise.all([runCli(['tell', 'AX-A1', 'run', 'the', 'tests']), playApp(['brain-2-0'])]);
		expect(r).toMatchObject({ code: 0, out: 'ax-a1\n' });
	});

	it('an unregistered connector gets a rejected receipt: exit 2 with the reason', async () => {
		const [r] = await Promise.all([runCli(['spawn', 'app', '--task', 'x'], { WCC_CONNECTOR: 'stranger' }), playApp(['brain-2-0'], 'stranger')]);
		expect(r.code).toBe(2);
		expect(r.err).toContain('connector "stranger" is not registered');
	});

	it('a tell into a journal is rejected with the app\'s reason', async () => {
		const [r] = await Promise.all([runCli(['tell', 'notes', 'hi']), playApp(['brain-2-0'])]);
		expect(r.code).toBe(2);
		expect(r.err).toContain('is a journal tile');
	});

	it('nobody draining: withdraws the request and exits 2', async () => {
		const r = await runCli(['spawn', 'app', '--task', 'x', '--wait-ms', '300']);
		expect(r.code).toBe(2);
		expect(r.err).toContain('withdrawn, nothing will happen');
		expect(fs.readdirSync(path.join(coordDir, 'connectors', 'brain-2-0', 'requests')).filter((f) => f.endsWith('.json'))).toEqual([]);
	});

	it('drained but never answered: exits 3, not 2 — it may still happen', async () => {
		const [r] = await Promise.all([runCli(['tell', 'ax-a1', 'hi', '--wait-ms', '800']), takeRequest()]);
		expect(r.code).toBe(3);
		expect(r.err).toContain('may still happen');
	});

	it('refuses to send without a connector or without required args', async () => {
		expect((await runCli(['tell', 'ax-a1', 'hi'], { WCC_CONNECTOR: '' })).code).toBe(2);
		expect((await runCli(['spawn', 'app'])).code).toBe(2);
		expect((await runCli(['tell', 'ax-a1'])).code).toBe(2);
		expect(fs.existsSync(path.join(coordDir, 'connectors'))).toBe(false);
	});

	it('floor: reads state.json, needs no connector, and warns when it is stale', async () => {
		fs.mkdirSync(path.join(coordDir, 'floor'));
		const write = (ts: number) => fs.writeFileSync(path.join(coordDir, 'floor', 'state.json'), renderFloorState(buildFloorState({
			workspaceId: 'default', ts, intervalMs: 4000, scannedAt: null, worktrees: [],
			sessions: [{ id: 1, name: 'ax-a1', kind: 'terminal', repo: 'app', branch: 'wt/main-1', worktreePath: '/w', busy: true, hidden: false, snapshotFile: null }],
		})));
		write(Date.now());
		const fresh = await runCli(['floor'], { WCC_CONNECTOR: '' });
		expect(fresh.code).toBe(0);
		expect(fresh.out).toContain('ax-a1  app · wt/main-1  busy');
		expect(fresh.err).toBe('');
		write(Date.now() - 60_000);
		const stale = await runCli(['floor', '--json']);
		expect(stale.code).toBe(0);
		expect(JSON.parse(stale.out).terminals[0].name).toBe('ax-a1');
		expect(stale.err).toContain('not refreshing it');
	});

	it('floor: a missing state file is a failure with a reason', async () => {
		const r = await runCli(['floor']);
		expect(r.code).toBe(2);
		expect(r.err).toContain('no floor state');
	});
});
