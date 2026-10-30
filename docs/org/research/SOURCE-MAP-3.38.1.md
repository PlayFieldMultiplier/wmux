# SOURCE-MAP for wmux 3.38.1

Status: source tag v3.38.1 at 245ba5e80 (`git rev-parse v3.38.1^{commit}` = 245ba5e80, verified), read 2026-10-30, by a subagent. Reviewed by AO_WMUX: spot-check of 14 citations against the locked checkout on 2026-10-30 (see section 5). Target: L-22.

Source root read: `C:\.______\.KADMON\.WMUX__\src\openwong2kim\wmux\checkout\tag-v3.38.1` (read only). Repo paths below are relative to that root as `src/...`.

## 1. Top-level layout

".ts count" is the number of `.ts` files directly inside the directory (`ls`), verified per directory. Files in subdirectories are not summed (no recursive count was taken).

| path | purpose | entrypoint | .ts count (immediate) |
|---|---|---|---|
| src/cli | `wmux` command-line client: command handlers, pipe client, Tailscale helper | src/cli/index.ts (ls; `main()` call at file end) | 5 |
| src/company | Company Mode types, with core, main, mcp and renderer subfolders | src/company/types.ts (header: canonical Company Mode types); src/company/mcp/index.ts is the only index file in its subfolders | 1 |
| src/daemon | Long-running session/PTY daemon: pipe server, session pipes, channels, A2A, approvals, LAN link, web terminal | src/daemon/index.ts (ls; bundled by `build:daemon`) | 22 |
| src/main | Electron main process: pipe RPC server, PTY management, windows, deck, MCP registration, updater | src/main/index.ts (ls; forge.config.ts:445) | 10 |
| src/mcp | MCP server for agent panes (stdio entry, broker/shim files, Playwright engine) | src/mcp/entry.ts (ls; `mcp` script in package.json) | 14 |
| src/preload | Electron preload bridge exposing `electronAPI` to the renderer | src/preload/preload.ts (ls; forge.config.ts:450) | 1 |
| src/renderer | React renderer UI: components, stores, terminal, hooks, plugins, i18n | src/renderer/index.tsx (ls; index.html:10) | 3 |
| src/shared | Code shared by main, daemon, cli and mcp: constants (IPC names, pipe paths), types, security, helpers | src/shared/constants.ts and src/shared/types.ts (ls; header comments) | 54 |
| src/test-utils | Test-only helper (`waitFor`); header says nothing in `src/` outside tests should import it | src/test-utils/waitFor.ts (ls) | 1 |

## 2. Process entrypoints

| process | entry file | verified how |
|---|---|---|
| Electron main | src/main/index.ts | forge.config.ts:444-446 maps `entry: 'src/main/index.ts'` to the vite main build; package.json `"main": ".vite/build/index.js"` is the build output. The mapping from `.vite/build/index.js` to src/main/index.ts is inferred from the forge config, not from the built file. |
| Preload | src/preload/preload.ts | forge.config.ts:449-451 `entry: 'src/preload/preload.ts'`, `config: 'vite.preload.config.ts'`; `contextBridge.exposeInMainWorld('electronAPI', ...)` at src/preload/preload.ts:1173 |
| Renderer | src/renderer/index.tsx | index.html:10 `<script type="module" src="/src/renderer/index.tsx">`; renderer config is vite.renderer.config.ts (forge.config.ts renderer block) |
| Daemon | src/daemon/index.ts | package.json `build:daemon`: `tsc -p tsconfig.daemon.json` (rootDir src, outDir dist/daemon) then esbuild `dist/daemon/daemon/index.js` to `dist/daemon-bundle/index.js`. Startup `catch` / fatal-error block is at the end of src/daemon/index.ts. |
| CLI | src/cli/index.ts | package.json `bin`: `"wmux": "dist/cli-bundle/index.js"`; `build:cli` esbuild from `dist/cli/cli/index.js`; `main();` call at the end of src/cli/index.ts |
| MCP stdio (legacy single-child entry) | src/mcp/entry.ts | package.json `"mcp": "node dist/mcp/mcp/entry.js"`; tsconfig.mcp.json rootDir src; src/mcp/entry.ts:9-10 says the broker topology (src/mcp/shim.ts + src/mcp/broker.ts) replaces it |

## 3. Pipe and IPC surfaces

- Main RPC named pipe name: src/shared/constants.ts:507 `getPipeName()`, Windows return at line 512: `\\.\pipe\wmux<suffix>-<user>`. Listener: src/main/pipe/PipeServer.ts:101 `net.createServer`, :150 `listen(pipeName)`. Client: src/cli/client.ts:146 uses `getPipeName()`.
- Main TCP fallback: src/main/pipe/PipeServer.ts:204 `tcpServer = net.createServer`, :221 `listen(0, '127.0.0.1')`. Port file path: src/shared/constants.ts:627 `getTcpPortPath()`.
- MCP broker named pipe: src/shared/constants.ts:524 `getMcpBrokerPipeName()`, Windows return at line 527: `\\.\pipe\wmux-mcpb<suffix>-<user>`. Listener: src/mcp/broker.ts:260 `server.listen(pipeName, ...)` and :266 (verified by grep, AO_WMUX).
- Daemon control named pipe: src/shared/constants.ts:657 `getDaemonSocketPath()`, Windows return at line 660: `\\.\pipe\wmux-daemon<suffix>-<user>`. Default in src/daemon/config.ts:36-37 (`getDefaultPipeName`) and :94. Server: src/daemon/DaemonPipeServer.ts:251 `net.createServer`, :301 `server.listen(name)`; constructed at src/daemon/index.ts:4321. The bound name is written to `~/.wmux/daemon-pipe` at src/daemon/index.ts:4974-4976.
- Per-session data pipe: src/shared/constants.ts:675 `getSessionSocketPath(sessionId)`, Windows return `\\.\pipe\wmux-session-<id>`. Server: src/daemon/SessionPipe.ts:129 `net.createServer`, :165 `server.listen(pipeName)`; stale-socket unlink at :89-91.
- Daemon web terminal HTTP server: src/daemon/web/WebTerminalServer.ts:713 `http.createServer`.
- LAN link server (daemon): src/daemon/lanlink/server.ts:190 comment says it is the only place `net.Server.listen()` appears; `server.listen(port, ip)` at :219.
- Electron IPC channel-name table: src/shared/constants.ts declares `export const IPC = {` (next to the `// IPC Channel names` comment near the top of the file). Exact line: src/shared/constants.ts:2 (verified by grep, AO_WMUX).
- Preload exposed APIs: src/preload/preload.ts:1173 `exposeInMainWorld('electronAPI', ...)`, :1185 `exposeInMainWorld('clipboardAPI', ...)`.

## 4. Not verified

- Recursive `.ts` counts per top-level directory: only immediate counts were taken (`ls`), per the method. Totals for subfolders are not computed.
- MCP broker named-pipe listener location (src/mcp/broker.ts or src/main side): not grepped.
- Electron main startup code: a grep for `app.whenReady` in src/main/index.ts returned no match, and the file was not read further. The `main` entry behavior is taken from the forge config only.
- Purposes in section 1 are from file names, subfolder names and file header comments. Subfolder contents other than their listed file names were not read.
- Whether the built artifact `.vite/build/index.js` is produced from src/main/index.ts beyond the forge config mapping: not checked by building.
- AO_WMUX review of this map: not performed (status line says PENDING).
- Behavior of the pipe names at runtime (dev vs prod suffix via `dataSuffix()`): not traced.

## 5. AO_WMUX spot-check (2026-10-30)

Checked against `tag-v3.38.1` with sed and grep:

- constants.ts 507/512 (getPipeName), 524/527 (getMcpBrokerPipeName), 657/660 (getDaemonSocketPath), 675 (getSessionSocketPath return): pass.
- PipeServer.ts 101, 150, 204, 221: pass.
- preload.ts 1173 (`electronAPI`) and 1185 (`clipboardAPI`): pass.
- forge.config.ts 444-451 (main and preload entries): pass.
- package.json `main` `.vite/build/index.js`, `bin` `wmux`: pass.
- IPC table at constants.ts:2, and the MCP broker listens at mcp/broker.ts:260 and :266: resolved from UNVERIFIED.

Not checked by AO_WMUX: the recursive `.ts` counts, the subfolder purposes in section 1, and the runtime behaviour of the pipe names (section 4).
