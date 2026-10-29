import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseNewTabFields, REMOTE_CHOICES, type NewTabResult } from '../src/new-tab';
import { GITIGNORE_KINDS } from '../src/new-repo-params';
import { parseOutboxMessage } from '../src/terminals/god';
import { evaluateConnectorRequest, receiptFilename } from '../src/terminals/connectors';
import { sanitizeSessionEnv } from '../src/terminals/session-env';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../pty-sidecar/new-tab-core.cjs');
const COORD = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
const WCC = path.join(__dirname, '..', 'pty-sidecar', 'wcc-client.cjs');

const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(sanitizeSessionEnv(process.env)).filter(([k]) => !k.startsWith('WCC_')),
);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newtab-cli-')); });

function run(cli: string, args: string[], env: Record<string, string>, cwd?: string): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile('node', [cli, ...args], { env: { ...BASE_ENV, ...env }, encoding: 'utf8', cwd },
			(e, out, err) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out, err }));
	});
}
const kane = (args: string[], env: Record<string, string> = {}, cwd?: string) =>
	run(COORD, ['new-tab', ...args], { COS_COORD_DIR: dir, COS_ROLE: 'god', COS_TERMINAL_NAME: 'Kane', ...env }, cwd);
const outside = (args: string[], env: Record<string, string> = {}) =>
	run(WCC, ['new-tab', ...args], { WCC_COORD_DIR: dir, WCC_CONNECTOR: 'brain-2-0', ...env });

/** Wait for one .json to land in `d`, claim it the way the app's drains do (rename into .done/),
 *  and hand back its name and text. */
async function take(d: string): Promise<{ file: string; text: string }> {
	const start = Date.now();
	for (;;) {
		const files = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];
		if (files.length) {
			fs.mkdirSync(path.join(d, '.done'), { recursive: true });
			const text = fs.readFileSync(path.join(d, files[0]), 'utf8');
			fs.renameSync(path.join(d, files[0]), path.join(d, '.done', files[0]));
			return { file: files[0], text };
		}
		if (Date.now() - start > 5000) throw new Error('no request arrived');
		await new Promise((r) => setTimeout(r, 20));
	}
}

const result = (o: Partial<NewTabResult> = {}): NewTabResult => ({
	workspaceId: 'site', tab: 'Site', repo: 'Site', repoPath: '/dev/Site', branch: 'main', created: true,
	coordDir: '/ud/.coordination/site', remoteUrl: null, warnings: [], ...o,
});

/** The app's half of Kane's channel: parse with the app's own parsers, then file `answer`. */
async function playKane(answer: (fields: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
	const out = path.join(dir, 'god-outbox');
	const { file, text } = await take(out);
	const msg = parseOutboxMessage(text);
	if (!msg || msg.kind !== 'new-tab') throw new Error(`not a new-tab: ${text}`);
	const f = parseNewTabFields(msg.request);
	const receipt = f.ok ? answer(f.fields as unknown as Record<string, unknown>) : { ok: false, reason: f.reason };
	fs.mkdirSync(path.join(out, '.receipts'), { recursive: true });
	fs.writeFileSync(path.join(out, '.receipts', file), JSON.stringify(receipt));
	return f.ok ? (f.fields as unknown as Record<string, unknown>) : {};
}

describe('new-tab-core', () => {
	it('carries exactly the enum values the app accepts', () => {
		expect([...core.GITIGNORE_KINDS].sort()).toEqual(GITIGNORE_KINDS.map((k) => k.id).sort());
		expect([...core.REMOTE_CHOICES].sort()).toEqual([...REMOTE_CHOICES].sort());
	});
	it('builds fields the app parses back unchanged', () => {
		const argv = ['My Site', '--new-repo', 'site', '--parent', 'rel', '--base', 'trunk', '--gitignore', 'node', '--no-claude-md', '--remote', 'private'];
		const p = core.parseNewTabArgv(argv);
		const b = core.buildNewTabFields(p.name, p.flags, (x: string) => path.resolve('/base', x));
		expect(b.ok).toBe(true);
		expect(parseNewTabFields(b.fields)).toEqual({ ok: true, fields: b.fields });
		expect(b.fields).toEqual({ name: 'My Site', repo: null, newRepo: 'site', parent: path.resolve('/base', 'rel'), base: 'trunk', gitignore: 'node', claudeMd: false, remote: 'private' });
	});
	it('refuses what it can tell is wrong before sending', () => {
		expect(core.parseNewTabArgv(['a', '--remtoe', 'x'])).toEqual({ ok: false, reason: 'unknown flag --remtoe' });
		expect(core.parseNewTabArgv(['two', 'words'])).toMatchObject({ ok: false, reason: expect.stringContaining('quote it') });
		expect(core.buildNewTabFields('', {}, String)).toMatchObject({ ok: false });
		expect(core.buildNewTabFields('a', { gitignore: 'rust' }, String)).toMatchObject({ ok: false, reason: expect.stringContaining('--gitignore') });
		expect(core.buildNewTabFields('a', { 'claude-md': true, 'no-claude-md': true }, String)).toMatchObject({ ok: false });
	});
	it('reads both channels\' receipts', () => {
		expect(core.interpretNewTabReceipt({ ok: true, newTab: result() })).toEqual({ ok: true, result: result() });
		expect(core.interpretNewTabReceipt({ status: 'accepted', newTab: result() })).toEqual({ ok: true, result: result() });
		expect(core.interpretNewTabReceipt({ status: 'rejected', reason: 'no', leftOnDisk: '/x' })).toEqual({ ok: false, reason: 'no', leftOnDisk: '/x' });
		expect(core.interpretNewTabReceipt({ ok: true })).toMatchObject({ ok: false, reason: expect.stringContaining('malformed') });
	});
});

describe('cos-coord new-tab', () => {
	it('is the overseer\'s alone', async () => {
		const r = await kane(['Site'], { COS_ROLE: '' });
		expect(r).toMatchObject({ code: 2, err: expect.stringContaining('new-tab requires COS_ROLE=god') });
	});
	it('fails, not "allows", without a coordination dir', async () => {
		const r = await run(COORD, ['new-tab', 'Site'], { COS_ROLE: 'god' });
		expect(r.code).toBe(2);
		expect(r.err).toContain('needs COS_COORD_DIR');
	});
	it('a misspelt flag sends nothing', async () => {
		const r = await kane(['Site', '--gitignre', 'node']);
		expect(r).toMatchObject({ code: 2, err: expect.stringContaining('unknown flag --gitignre') });
		expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
	});
	it('accepted: prints the workspace id alone on stdout, the detail on stderr', async () => {
		const [r, fields] = await Promise.all([
			kane(['Site', '--parent', 'sub', '--remote', 'private'], {}, dir),
			playKane(() => ({ ok: true, message: 'm', newTab: result({ warnings: ['no GitHub remote: gh missing'] }) })),
		]);
		expect(r).toMatchObject({ code: 0, out: 'site\n' });
		expect(r.err).toContain('warning: no GitHub remote');
		expect(fields.parent).toBe(path.join(dir, 'sub')); // relative to the caller's cwd
	});
	it('--json prints the whole result', async () => {
		const [r] = await Promise.all([kane(['Site', '--json']), playKane(() => ({ ok: true, newTab: result() }))]);
		expect(JSON.parse(r.out)).toEqual(result());
	});
	it('refused: exit 2 with the app\'s reason', async () => {
		const [r] = await Promise.all([kane(['Site', '--repo', 'ghost']), playKane(() => ({ ok: false, reason: 'unknown repo "ghost". Known: app' }))]);
		expect(r).toMatchObject({ code: 2, err: expect.stringContaining('refused — unknown repo "ghost"') });
	});
	it('a repo left on disk without its commit: exit 4, not 2', async () => {
		const [r] = await Promise.all([kane(['Site']), playKane(() => ({ ok: false, reason: 'created /dev/Site, but its initial commit failed', leftOnDisk: '/dev/Site' }))]);
		expect(r.code).toBe(4);
		expect(r.err).toContain('LEFT A REPO ON DISK at /dev/Site');
	});
	it('nobody draining: withdraws the request — it can never fire later', async () => {
		const r = await kane(['Site'], { COS_COORD_NEW_TAB_WAIT_MS: '300' });
		expect(r.code).toBe(2);
		expect(r.err).toContain('WITHDRAWN');
		expect(fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))).toEqual([]);
	});
	it('drained but never answered: exit 3 — it may still happen', async () => {
		const [r] = await Promise.all([kane(['Site'], { COS_COORD_NEW_TAB_WAIT_MS: '800' }), take(path.join(dir, 'god-outbox'))]);
		expect(r.code).toBe(3);
		expect(r.err).toContain('may still happen');
	});
});

describe('wcc-client new-tab', () => {
	const reqDir = (): string => path.join(dir, 'connectors', 'brain-2-0', 'requests');
	/** The app's half of the connector channel, through the app's own decision. */
	async function playConnector(grants: string[], answer: Record<string, unknown> = { newTab: result() }): Promise<void> {
		const { text } = await take(reqDir());
		const o = evaluateConnectorRequest(text, { connectorId: 'brain-2-0', registeredConnectorIds: ['brain-2-0'], knownRepoNames: ['app'], grants });
		const receipt = o.status === 'rejected'
			? { v: 1, id: o.id, status: 'rejected', reason: o.reason, handledMs: 1 }
			: { v: 1, id: o.id, status: 'accepted', handledMs: 1, ...answer };
		const d = path.join(dir, 'connectors', 'brain-2-0', 'receipts');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, receiptFilename(String(o.id))), JSON.stringify(receipt));
	}

	it('granted: exit 0 and the workspace id', async () => {
		const [r] = await Promise.all([outside(['Site', '--repo', 'app']), playConnector(['new-tab'])]);
		expect(r).toMatchObject({ code: 0, out: 'site\n' });
	});
	it('registered but not granted: rejected with the fix', async () => {
		const [r] = await Promise.all([outside(['Site']), playConnector([])]);
		expect(r.code).toBe(2);
		expect(r.err).toContain('is not granted "new-tab"');
	});
	it('rejected with a folder left behind: exit 4', async () => {
		const [r] = await Promise.all([outside(['Site']), (async () => {
			const { text } = await take(reqDir());
			const id = JSON.parse(text).id;
			const d = path.join(dir, 'connectors', 'brain-2-0', 'receipts');
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, receiptFilename(id)), JSON.stringify({ v: 1, id, status: 'rejected', reason: 'commit failed', leftOnDisk: '/dev/Site', handledMs: 1 }));
		})()]);
		expect(r.code).toBe(4);
	});
	it('nobody draining: withdrawn, exit 2', async () => {
		const r = await outside(['Site', '--wait-ms', '300']);
		expect(r.code).toBe(2);
		expect(r.err).toContain('withdrawn, nothing will happen');
		expect(fs.readdirSync(reqDir()).filter((f) => f.endsWith('.json'))).toEqual([]);
	});
	it('a flag for another command is refused rather than dropped', async () => {
		expect(await outside(['Site', '--task', 'x'])).toMatchObject({ code: 2, err: expect.stringContaining('--task does not apply to new-tab') });
		const s = await run(WCC, ['spawn', 'app', '--task', 'x', '--repo', 'y'], { WCC_COORD_DIR: dir, WCC_CONNECTOR: 'brain-2-0' });
		expect(s).toMatchObject({ code: 2, err: expect.stringContaining('--repo does not apply to spawn') });
	});
});
