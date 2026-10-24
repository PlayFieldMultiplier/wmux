import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import * as pty from 'node-pty';
import { buildShimCmd } from '../../main/cliShim';

// The real CLI, run through the generated wmux.cmd in a real console (a ConPTY,
// as in a wmux pane) under code page 949, where a byte-wise UTF-8 write garbles
// Korean. Two commands that need no daemon carry Korean on each stream:
const STDERR_LINE = 'Unknown command: "한글명령". Run \'wmux --help\' for usage.';
const STDOUT_ERROR = '"error": "unknown subcommand: 한글"';
const ON_STDERR = '한글명령';
const ON_STDOUT = 'daemon 한글 --json';

const repo = nodePath.join(__dirname, '..', '..', '..');

type Run = { exitCode: number; screen: string; file: string | null };

/** A Squirrel-shaped root: `<root>\app-1.0.0\wmux.exe`, the CLI bundle beside the koffi it ships with, and `<root>\bin\wmux.cmd`. */
function makeRoot(parent: string, installExe: (app: string) => void): string {
  const root = nodeFs.mkdtempSync(nodePath.join(parent, 'wmux console (a&b) '));
  const app = nodePath.join(root, 'app-1.0.0');
  const bundle = nodePath.join(app, 'resources', 'cli-bundle');
  nodeFs.mkdirSync(nodePath.join(bundle, 'node_modules', '@koromix'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'bin'));
  nodeFs.writeFileSync(nodePath.join(root, 'bin', 'wmux.cmd'), buildShimCmd());
  installExe(app);
  // As package.json's build:cli and forge.config.ts ship it.
  buildSync({
    entryPoints: [nodePath.join(repo, 'src', 'cli', 'index.ts')], bundle: true, platform: 'node', format: 'cjs',
    outfile: nodePath.join(bundle, 'index.js'), external: ['koffi'], logLevel: 'silent',
  });
  nodeFs.cpSync(nodePath.join(repo, 'node_modules', 'koffi'), nodePath.join(bundle, 'node_modules', 'koffi'), { recursive: true });
  const koromix = `koffi-win32-${process.arch}`;
  nodeFs.cpSync(nodePath.join(repo, 'node_modules', '@koromix', koromix), nodePath.join(bundle, 'node_modules', '@koromix', koromix), { recursive: true });
  return root;
}

/** `wmux <args>` with `redirect` appended, in a console of its own under code page 949. */
function run(root: string, args: string, redirect = ''): Promise<Run> {
  const file = nodePath.join(root, 'redirected.txt');
  nodeFs.rmSync(file, { force: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(wmux_|electron_run_as_node$)/i.test(key)) env[key] = value;
  }
  // No daemon to reach: another data suffix, and a profile with no token or port file.
  Object.assign(env, { WMUX_DATA_SUFFIX: `-console-test-${process.pid}`, USERPROFILE: root, HOME: root });
  const line = `chcp 949 >nul & "${nodePath.join(root, 'bin', 'wmux.cmd')}" ${args} ${redirect.replace('FILE', `"${file}"`)}`;
  return new Promise((resolve) => {
    const term = pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${line}"`, { cols: 400, rows: 30, cwd: root, env, useConpty: true });
    let out = '';
    term.onData((data) => { out += data; });
    // node-pty emits exit once the output pipe has closed: every byte is in.
    term.onExit(({ exitCode }) => resolve({
      exitCode,
      // eslint-disable-next-line no-control-regex -- stripping the console's escape sequences is the point
      screen: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''),
      file: nodeFs.existsSync(file) ? nodeFs.readFileSync(file, 'utf8') : null,
    }));
  });
}

// wmux.exe is Electron run as Node, a GUI-subsystem program. With nothing
// redirected Electron attaches to the console itself and hands Node write-only
// console handles; with a stream redirected it does not attach, and the other
// stream arrives as no handle at all. A GUI-subsystem copy of Node cannot stand
// in: Node fills a missing std handle with NUL at startup, which is
// indistinguishable from a real `>nul`. Since Electron 42 `require('electron')`
// downloads a missing binary, so the installed one is looked up without it; CI's
// integration lane installs it with `npx install-electron`.
const electron = (() => {
  try {
    const dir = nodePath.dirname(createRequire(__filename).resolve('electron/package.json'));
    return nodePath.join(dir, 'dist', nodeFs.readFileSync(nodePath.join(dir, 'path.txt'), 'utf8').trim());
  } catch { return ''; }
})();

describe.skipIf(process.platform !== 'win32' || !electron || !nodeFs.existsSync(electron))('wmux CLI output on the console (Electron, code page 949)', () => {
  let root = '';
  beforeAll(() => {
    // Beside node_modules, so Electron's files can be hard links rather than copies.
    const parent = nodePath.join(repo, 'node_modules', '.cache');
    nodeFs.mkdirSync(parent, { recursive: true });
    root = makeRoot(parent, (app) => {
      const dist = nodePath.dirname(electron);
      for (const entry of nodeFs.readdirSync(dist, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const to = nodePath.join(app, entry.name === nodePath.basename(electron) ? 'wmux.exe' : entry.name);
        try { nodeFs.linkSync(nodePath.join(dist, entry.name), to); } catch { nodeFs.copyFileSync(nodePath.join(dist, entry.name), to); }
      }
    });
  }, 120_000);
  afterAll(() => { if (root) nodeFs.rmSync(root, { recursive: true, force: true }); });

  it('shows Korean intact on stdout and stderr with nothing redirected', async () => {
    const err = await run(root, ON_STDERR);
    expect(err.exitCode).toBe(1);
    expect(err.screen).toContain(STDERR_LINE);
    const out = await run(root, ON_STDOUT);
    expect(out.exitCode).toBe(1);
    expect(out.screen).toContain(STDOUT_ERROR);
  }, 60_000);

  it('keeps stderr on the console when stdout goes to a file, a pipe or NUL', async () => {
    const toFile = await run(root, ON_STDERR, '>FILE');
    expect(toFile.exitCode).toBe(1);
    expect(toFile.screen).toContain(STDERR_LINE);
    expect(toFile.file).toBe('');
    // The redirect itself still gets stdout, as UTF-8, and nothing of it reaches the console.
    const json = await run(root, ON_STDOUT, '>FILE');
    expect(json.screen).not.toContain('unknown subcommand');
    expect(json.file).toContain(STDOUT_ERROR);
    expect((await run(root, ON_STDERR, '| more')).screen).toContain(STDERR_LINE);
    expect((await run(root, ON_STDERR, '>nul')).screen).toContain(STDERR_LINE);
    expect((await run(root, ON_STDOUT, '>nul')).screen).not.toContain('unknown subcommand');
  }, 60_000);

  it('keeps stdout on the console when stderr goes to a file', async () => {
    const out = await run(root, ON_STDOUT, '2>FILE');
    expect(out.exitCode).toBe(1);
    expect(out.screen).toContain(STDOUT_ERROR);
    const err = await run(root, ON_STDERR, '2>FILE');
    expect(err.screen).not.toContain('Unknown command');
    expect(err.file).toContain(STDERR_LINE);
  }, 60_000);
});
