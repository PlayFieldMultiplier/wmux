import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomAgentNames } from '../customAgentNames';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-custom-agent-names-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The loader validates for the platform it runs on, and Windows refuses a POSIX
// path ('command-posix-path'), so the absolute-path entry is spelled for it.
const TERN_COMMAND = process.platform === 'win32' ? 'C:\\tern\\bin\\tern.exe' : '/opt/tern/bin/tern';

const write = (agents: unknown) => fs.writeFileSync(path.join(dir, 'custom-agents.json'), JSON.stringify({ agents }), 'utf8');

describe('CustomAgentNames', () => {
  it('maps each process name to its agent, re-reads a changed file, and keeps nothing it refuses', () => {
    let now = 0;
    const names = new CustomAgentNames(dir, () => now);
    const later = () => { now += 2_000; };
    expect(names.names().size).toBe(0);
    // Made-up CLIs. The second entry names a registry agent and is refused.
    write([{ name: 'Tern', command: TERN_COMMAND }, { name: 'Mine', command: 'claude' }]);
    // One read answers for a moment: a labelled pane asks on every event.
    expect(names.names().size).toBe(0);
    later();
    expect([...names.names()]).toEqual([['tern', 'Tern']]);
    write([{ name: 'Gull', command: 'gull', processNames: ['gull', 'Gull-Daemon.exe'] }]);
    later();
    expect([...names.names()]).toEqual([['gull', 'Gull'], ['gull-daemon', 'Gull']]);
    // Named like a registry agent: kept by the loader, never a label.
    write([{ name: 'Amp', command: 'amp-work' }, { name: 'Gull', command: 'gull' }]);
    later();
    expect([...names.names()]).toEqual([['gull', 'Gull']]);
    // An oversized file is unreadable, not parsed.
    fs.writeFileSync(path.join(dir, 'custom-agents.json'), JSON.stringify({ agents: [{ name: 'Gull', command: 'gull' }], pad: 'x'.repeat(300 * 1024) }), 'utf8');
    later();
    expect(names.names().size).toBe(0);
    fs.writeFileSync(path.join(dir, 'custom-agents.json'), '{ nope', 'utf8');
    later();
    expect(names.names().size).toBe(0);
  });
});
