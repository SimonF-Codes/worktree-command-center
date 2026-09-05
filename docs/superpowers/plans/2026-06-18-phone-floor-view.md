---
status: stable
---

# Phone Floor View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** A Tailscale-reachable, token-gated mobile page showing the active workspace's floor (incl. Kane), with per-terminal remote-control toggle + spawn.

**Architecture:** HTTP server in Electron main serves a mobile page + JSON; the renderer pushes floor state every 2s and handles phone actions over IPC.

Spec: `docs/superpowers/specs/2026-06-18-phone-floor-view-design.md`

---

## Task 1: pure net helper + test

**Files:** Create `electron/remote-net.ts`; Test `tests/remote-net.test.ts`.

- [ ] **Test** (`tests/remote-net.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { pickHosts } from '../electron/remote-net';

describe('pickHosts', () => {
  const ifaces = {
    eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    ts0: [{ family: 'IPv4', address: '100.92.3.4', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  } as any;
  it('lists the Tailscale (100.64/10) IP first, then LAN, skips loopback', () => {
    expect(pickHosts(ifaces, 'mybox')).toEqual(['100.92.3.4', 'mybox', '192.168.1.20']);
  });
  it('falls back to hostname + LAN when no tailscale', () => {
    expect(pickHosts({ eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] } as any, 'h')).toEqual(['h', '10.0.0.5']);
  });
});
```

- [ ] **Impl** (`electron/remote-net.ts`):

```ts
import type { NetworkInterfaceInfo } from 'os';

/** Is an IPv4 in Tailscale's 100.64.0.0/10 CGNAT range? */
export function isTailscaleIp(ip: string): boolean {
	const m = /^(\d+)\.(\d+)\./.exec(ip);
	if (!m) return false;
	const a = +m[1]!, b = +m[2]!;
	return a === 100 && b >= 64 && b <= 127;
}

/** Ordered host candidates for the phone URL: Tailscale IP(s) first, then hostname, then LAN IPv4s. */
export function pickHosts(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>, hostname: string): string[] {
	const ts: string[] = [], lan: string[] = [];
	for (const list of Object.values(ifaces)) {
		for (const i of list ?? []) {
			if (i.family !== 'IPv4' || i.internal) continue;
			(isTailscaleIp(i.address) ? ts : lan).push(i.address);
		}
	}
	return [...ts, hostname, ...lan];
}

export function accessUrls(hosts: string[], port: number, token: string): string[] {
	return hosts.map((h) => `http://${h}:${port}/?t=${token}`);
}
```

- [ ] **Run + commit.** `npx vitest run tests/remote-net.test.ts` → pass. `git commit -m "feat(phone): pure host/url helper"`

---

## Task 2: grid + Kane floor data

**Files:** Modify `src/terminals/terminals-grid.ts`, `src/terminals/god-console.ts`.

- [ ] **GodConsole.recentOutput()** — add (mirrors TerminalTile.recentOutput):

```ts
	recentOutput(): string {
		const t = this.term;
		if (!t) return '';
		const buf = t.buffer.active; const lines: string[] = [];
		for (let i = buf.length - 1; i >= 0 && lines.length < 20; i--) {
			const row = buf.getLine(i); if (!row) continue;
			const s = row.translateToString(true).trimEnd(); if (s) lines.unshift(s);
		}
		return lines.join('\n');
	}
```

- [ ] **Grid additions** — types + methods near `attentionItems()`:

```ts
export interface RemoteTerminal { id: number; name: string; repo: string; branch: string; state: string; output: string; remoteOn: boolean; }
```

```ts
	private tileState(t: TerminalTile): string {
		const o = t.recentOutput();
		if (looksLikePrompt(o)) return 'prompt';
		if (looksLikeMenu(o)) return 'menu';
		if (looksErrored(o)) return 'errored';
		return this.idleTiles.has(t.tileId) ? 'idle' : 'running';
	}

	/** Floor snapshot for the phone view: every session (+ Kane) with state + recent output. */
	floorState(): RemoteTerminal[] {
		const out: RemoteTerminal[] = this.allSessions().map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch,
			state: this.tileState(t), output: t.recentOutput().split('\n').slice(-12).join('\n'), remoteOn: t.isRemoteOn,
		}));
		if (this.godConsole) {
			const ko = this.godConsole.recentOutput();
			out.unshift({ id: -1, name: 'Kane', repo: '—', branch: '—',
				state: looksLikePrompt(ko) ? 'prompt' : looksLikeMenu(ko) ? 'menu' : 'running',
				output: ko.split('\n').slice(-12).join('\n'), remoteOn: false });
		}
		return out;
	}

	repoNames(): string[] { return this.repos.map((r) => r.name); }

	/** Toggle remote-control on a terminal by id (from the phone). */
	toggleRemoteById(id: number): void { this.allSessions().find((t) => t.tileId === id)?.toggleRemoteControl(); }

	/** Spawn a worktree terminal for a repo by name, on a base, with a kickoff task (from the phone). */
	async spawnFromName(repoName: string, base: string | null, task: string): Promise<void> {
		const repo = this.repos.find((r) => r.name === repoName) ?? this.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
		if (!repo) return;
		const baseBranch = base ?? (defaultBranch(await listBranches(repo.path)) ?? 'main');
		await this.spawnWorktree(repo, baseBranch, { task });
	}
```

  Then make `spawnFromKane` delegate: replace its body with `await this.spawnFromName(repoName, base, task)` (keeping the unknown-repo god-inbox note inside `spawnFromKane`).

  Import `looksErrored` (already importing `looksLikeMenu` from prompt-detect → add `looksErrored`).

- [ ] **tsc + commit.** `npx tsc -noEmit -skipLibCheck`. `git commit -m "feat(phone): grid floorState + remote/spawn-by-id, Kane recentOutput"`

---

## Task 3: preload bridge

**Files:** Modify `electron/preload.ts`, and the `Window.wcc` type in `src/app.ts`.

- [ ] Add to `window.wcc` in preload:

```ts
	pushFloorState: (s: unknown) => ipcRenderer.send('remote:state', s),
	onRemoteAction: (cb: (a: any) => void) => ipcRenderer.on('remote:action', (_e, a) => cb(a)),
	remoteInfo: () => ipcRenderer.invoke('remote:info'),
```

- [ ] Extend the `Window.wcc` interface in `src/app.ts` with the three signatures (`pushFloorState(s): void; onRemoteAction(cb): void; remoteInfo(): Promise<{token:string;port:number;urls:string[]}>`).

- [ ] **tsc + commit.**

---

## Task 4: main HTTP server

**Files:** Create `electron/remote-server.ts`; wire in `electron/main.ts`.

- [ ] **`electron/remote-server.ts`** — exports `startRemoteServer(opts: { port: number; getWindow: () => BrowserWindow | null }): { token: string }`. Implements:
  - `crypto.randomBytes(8).toString('hex')` token.
  - module `let floorState = { terminals: [], repos: [] }`; `ipcMain.on('remote:state', (_e, s) => floorState = s)`.
  - `http.createServer` on `0.0.0.0:port`: `GET /` → `MOBILE_HTML`; `GET /api/floor` → token-check → `floorState` JSON; `POST /api/action` → token-check → read body → `getWindow()?.webContents.send('remote:action', JSON.parse(body))` → `{ok:true}`.
  - token-check: `new URL(req.url, 'http://x').searchParams.get('t') === token` else 401.
  - `MOBILE_HTML`: the self-contained page (poll `/api/floor?t=`, render cards + Remote button + Spawn form, POST actions; reads `t` from `location.search`).

- [ ] **`electron/main.ts`** — import `startRemoteServer` + `os` + `remote-net`; in `createWindow`, after `win` exists:

```ts
	const { token } = startRemoteServer({ port: 7420, getWindow: () => mainWindow });
	ipcMain.handle('remote:info', () => ({ token, port: 7420, urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname(), 7420, token)) }));
```

  (Add a module `let mainWindow: BrowserWindow | null` set to `win`. `accessUrls`/`pickHosts` from `remote-net`.) Fix the `accessUrls` call to pass `(hosts, port, token)`.

- [ ] **Build + commit.** `npm run build`.

---

## Task 5: renderer wiring + 📱 button

**Files:** Modify `src/app.ts`, `app.css`.

- [ ] In `main()` after `await activeGrid.mount(...)`:

```ts
		window.setInterval(() => window.wcc.pushFloorState({ terminals: activeGrid.floorState(), repos: activeGrid.repoNames() }), 2000);
		window.wcc.onRemoteAction((a: { type: string; id?: number; repo?: string; base?: string; task?: string }) => {
			if (a.type === 'remote' && typeof a.id === 'number') activeGrid.toggleRemoteById(a.id);
			else if (a.type === 'spawn' && a.repo && a.task) void activeGrid.spawnFromName(a.repo, a.base ?? null, a.task);
		});
		const phoneBtn = topBar.createEl('button', { cls: 'wcc-phone', text: '📱 Phone' });
		phoneBtn.addEventListener('click', () => { void window.wcc.remoteInfo().then((info) => {
			toast('Phone access — open on your phone (Tailscale):\n' + info.urls.join('\n'));
		}); });
```

  (Place `phoneBtn` in the topbar near the usage/attention widgets.)

- [ ] **Build + commit.** `npm run build && npm test`.

- [ ] **Manual (phone, over Tailscale):** click 📱 Phone → open a URL on the phone → see the floor + Kane; tap a terminal's Remote control → it appears in the Claude app; Spawn → a new terminal opens on the desktop.

---

## Self-Review
- Spec §3.1 server → T4; §3.2 preload → T3; §3.3 grid/app → T2,T5; §3.4 page → T4; net helper §5 test → T1.
- Types: `RemoteTerminal` (T2), `pickHosts`/`accessUrls` (T1), `window.wcc` additions (T3) used in T5/T4. `spawnFromKane` delegates to `spawnFromName`. `looksErrored` imported in the grid.
