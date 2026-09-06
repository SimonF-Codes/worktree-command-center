---
status: stable
---

# Phone Floor View — Design

> Status: approved design, pre-implementation. Date: 2026-06-18.

## 1. Goal

View the floor from your phone (over Tailscale, anywhere): a read-only list of the active
workspace's terminals (incl. Kane) with their state + recent output, where you can **tap a terminal
to enable Claude remote-control** (then work it in the Claude app) and **spawn a new terminal**.
The command center serves its own small mobile page; the Claude app handles actually *working* a
single remote-controlled session.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Reach | **Tailscale.** HTTP server binds `0.0.0.0`; phone on the tailnet hits the desktop's Tailscale IP (`100.x.y.z`) / MagicDNS name. No public exposure, no port-forward. |
| Auth | A random **token** generated at startup, required on every `/api/*` call; embedded in the access URL the app shows. |
| Floor scope (v1) | The **active workspace** only (the grid currently mounted), plus Kane. Cross-workspace aggregation is a follow-up. |
| Phone can | read-only floor (name · repo · branch · state · recent output, incl. Kane); per-terminal **Enable remote control**; **+ Spawn** (repo · base · task). |
| Access UI | A **📱 Phone** button in the topbar opens a panel with the URL(s) + token (text). QR is a follow-up. |
| Port | `7420` (fixed; configurable later). |

## 3. Architecture

Three layers + the mobile page.

### 3.1 Electron main — `electron/remote-server.ts` (new) + wiring in `electron/main.ts`

- An `http` server bound to `0.0.0.0:7420`. Routes:
  - `GET /` → the mobile page HTML (self-contained string).
  - `GET /api/floor?t=<token>` → the cached floor JSON `{ terminals: [...], repos: [...] }`. 401 if token wrong/missing.
  - `POST /api/action?t=<token>` → JSON body `{type:'remote', id}` or `{type:'spawn', repo, base, task}`; forwarded to the renderer; 401 if token wrong.
- **Token:** `crypto.randomBytes(8).toString('hex')` at startup.
- **Tailscale/host detection:** scan `os.networkInterfaces()` for an IPv4 in `100.64.0.0/10` (Tailscale CGNAT range) → that's the Tailscale IP; also collect the machine hostname + the LAN IPv4 as fallbacks. Returned in `remote:info`.
- **Cached floor state:** module-level `floorState`, updated by `ipcMain.on('remote:state', (_e, s) => floorState = s)`.
- **Actions:** on `POST /api/action`, `mainWindow.webContents.send('remote:action', body)`.
- `ipcMain.handle('remote:info', () => ({ token, port, urls }))` where `urls` are
  `http://<tailscale-ip|hostname|lan-ip>:7420/?t=<token>`.
- Server started in `createWindow` after the window exists; kept across the app lifetime.

### 3.2 Preload — `electron/preload.ts`

Extend `window.wcc`:
```ts
pushFloorState: (s) => ipcRenderer.send('remote:state', s),
onRemoteAction: (cb) => ipcRenderer.on('remote:action', (_e, a) => cb(a)),
remoteInfo: () => ipcRenderer.invoke('remote:info'),
```

### 3.3 Renderer — grid + app wiring

**`terminals-grid.ts`:**
- `floorState(): RemoteTerminal[]` — for `allSessions()`: `{ id, name, repo, branch, state, output, remoteOn }`.
  - `state`: `looksLikePrompt` → `'prompt'`; else `looksLikeMenu` → `'menu'`; else `looksErrored` → `'errored'`; else `idleTiles.has(id)` → `'idle'`; else `'running'`.
  - `output`: last ~12 non-blank lines of `recentOutput()`.
  - `remoteOn`: `tile.isRemoteOn`.
  - Append a Kane entry `{ id:-1, name:'Kane', repo:'—', branch:'—', state, output, remoteOn:false }` when the GOD console exists (using `godConsole.recentOutput()`).
- `toggleRemoteById(id)`: find the tile, `tile.toggleRemoteControl()`.
- `spawnFromName(repoName, base, task)`: public wrapper around the existing `spawnFromKane` logic (resolve repo by name, default base, spawn with task). (Refactor `spawnFromKane` to call `spawnFromName`.)
- `repoNames(): string[]` for the spawn form.

**`god-console.ts`:** add `recentOutput(): string` (last ~20 non-blank lines of its xterm buffer, mirroring `TerminalTile.recentOutput`).

**`app.ts`:**
- After grids set up: a pusher — `setInterval(() => window.wcc.pushFloorState({ terminals: activeGrid.floorState(), repos: repos.map((r) => r.name) }), 2000)`.
- `window.wcc.onRemoteAction((a) => { if (a.type === 'remote') activeGrid.toggleRemoteById(a.id); else if (a.type === 'spawn') void activeGrid.spawnFromName(a.repo, a.base, a.task); })`.
- A **📱 Phone** topbar button → `await window.wcc.remoteInfo()` → show a small panel (URL list + token) so the user can open it on the phone.

### 3.4 Mobile page (served by 3.1)

Self-contained dark page. On load: read `t` from `location.search`. Poll `GET /api/floor?t=…` every 2s; render terminal cards (name · repo·branch · state badge · last lines · **📱 Remote control** button → `POST /api/action {type:'remote',id}`). A **+ Spawn** section (repo `<select>` from `repos`, base input, task textarea → `POST {type:'spawn',…}`). Minimal vanilla JS.

## 4. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| No Tailscale IP found | Fall back to hostname + LAN IP in the URL list; the panel shows all. |
| Token leak on LAN | Server also answers on LAN, so the token gates `/api/*` regardless. |
| Renderer hasn't pushed yet | `floorState` starts `{terminals:[],repos:[]}`; page shows "waiting…". |
| Phone can spawn agents | Token-gated; v1 trusts the tailnet + token. |
| Action when no active grid | Renderer guards (activeGrid always exists). |
| Server port in use | Log + the feature degrades (panel shows an error); fixed port for v1. |
| Can't verify from here | Build to spec; user verifies on phone over their tailnet. |
| `--dangerously-skip-permissions` + remote control | Documented earlier: a remote-controlled tile starts surfacing prompts; tooltip already warns. |

## 5. Testing

- **`tests/remote-floor.test.ts`** — pure `tailscaleUrls(interfaces, hostname, port, token)` (picks the 100.64/10 IP, builds URLs) and `floorTerminalState(flags)` (the prompt>menu>errored>idle>running precedence), extracted as pure helpers in `electron/remote-net.ts` / reusing `attention`/`prompt-detect`.
- Server routing + IPC + mobile page + the whole flow are IO/integration — verified by build + the user's phone over Tailscale.

## 6. Out of scope (v1)

- QR code, cross-workspace floor aggregation, sending arbitrary input from the phone (the Claude app
  does that via remote-control), HTTPS/cert, configurable port, public tunnel.
