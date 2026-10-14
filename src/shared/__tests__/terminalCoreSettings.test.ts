import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../nativeTerminalCore', () => ({ loadNativeTerminalCore: vi.fn() }));
let dir: string;
beforeEach(() => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-engine-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.stubEnv('WMUX_TERMINAL_CORE', undefined);
  vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('persisted terminal engine', () => {
  it('keeps Node as the default when the packaged Rust module is available', async () => {
    const native = await import('../nativeTerminalCore');
    vi.mocked(native.loadNativeTerminalCore).mockReturnValue({} as never);
    const settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreRuntime()).toEqual({
      requested: 'node', effective: 'node', rustAvailable: true, environmentOverride: false,
    });
  });
  it('keeps the live host unchanged until the next boot, in both directions', async () => {
    let settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('node');
    settings.writeTerminalEngine('rust');
    expect(settings.readTerminalEngine()).toBe('rust');
    expect(settings.terminalCoreSelection()).toBe('node');
    vi.resetModules();
    settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('rust');
    settings.writeTerminalEngine('node');
    expect(settings.terminalCoreSelection()).toBe('rust');
    vi.resetModules();
    settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('node');
  });
  it('fails back to Node for malformed preferences and rejects invalid writes', async () => {
    const settings = await import('../terminalCoreSettings');
    const file = path.join(dir, 'invalid.json');
    for (const content of ['{', 'null', '{"engine":true}', '{"engine":"other"}']) {
      fs.writeFileSync(file, content);
      expect(settings.readTerminalEngine(file)).toBe('node');
    }
    expect(() => settings.writeTerminalEngine('other', file)).toThrow('Invalid');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"engine":"other"}');
  });
  it('isolates instances and honors explicit environment overrides', async () => {
    const settings = await import('../terminalCoreSettings');
    settings.writeTerminalEngine('rust');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-other');
    expect(settings.readTerminalEngine()).toBe('node');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    expect(settings.terminalCoreSelection()).toBe('node');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'rust');
    const native = await import('../nativeTerminalCore');
    vi.mocked(native.loadNativeTerminalCore).mockImplementation(() => { throw new Error('missing'); });
    expect(settings.terminalCoreRuntime()).toEqual({ requested: 'rust', effective: 'node', rustAvailable: false, environmentOverride: true });
  });
});
