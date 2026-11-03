/**
 * readStdin must not hang a hook. Incident (2026-11-03): a Stop hook ran for
 * 25 minutes because the bridge waited on stdin that never closed. The RPC has
 * a 2s cap, but the stdin read had none.
 *
 * These tests run the REAL readStdin: the CLI entrypoint is stripped (main()
 * runs at module top level and reads stdin), and readStdin is re-exported from
 * a temp copy. USERPROFILE points at a temp dir so the bridge's own log lines
 * never reach the production ~/.wmux/bridge.log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let savedUserProfile: string | undefined;
let readStdin: (stream: NodeJS.ReadableStream, timeoutMs?: number) => Promise<unknown>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-stdin-'));
  savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = tmp;
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  // Strip the shebang: vite's transform rejects it on Windows.
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { readStdin };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ readStdin } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  process.env.USERPROFILE = savedUserProfile;
  rmSync(tmp, { recursive: true, force: true });
});

describe('readStdin (fix: a stdin that never closes must not hang the hook)', () => {
  it('resolves null after the timeout when stdin never ends', async () => {
    const stream = new PassThrough();
    const started = Date.now();
    const result = await readStdin(stream, 200);
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
    expect(stream.destroyed).toBe(true);
  });

  it('parses a complete JSON payload that ends before the timeout', async () => {
    const stream = new PassThrough();
    const pending = readStdin(stream, 2000);
    stream.end('{"session_id":"s1","hook_event_name":"Stop"}');
    await expect(pending).resolves.toEqual({ session_id: 's1', hook_event_name: 'Stop' });
  });

  it('resolves null for an empty stdin that ends at once', async () => {
    const stream = new PassThrough();
    const pending = readStdin(stream, 2000);
    stream.end();
    await expect(pending).resolves.toBeNull();
  });

  it('does not fire the timer after a normal end (no late destroy of a finished read)', async () => {
    // Start from an empty temp log: test 1 deliberately writes stdin-timeout.
    rmSync(path.join(tmp, '.wmux'), { recursive: true, force: true });
    const stream = new PassThrough();
    const pending = readStdin(stream, 300);
    stream.end('{"ok":true}');
    await expect(pending).resolves.toEqual({ ok: true });
    // Wait past the timeout. If the timer were not cleared it would fire and
    // log a false stdin-timeout into the temp bridge log.
    await new Promise((r) => setTimeout(r, 400));
    const logFile = path.join(tmp, '.wmux', 'bridge.log');
    const log = (() => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } })();
    expect(log).not.toContain('stdin-timeout');
  });
});
