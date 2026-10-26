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

const write = (agents: unknown) => fs.writeFileSync(path.join(dir, 'custom-agents.json'), JSON.stringify({ agents }), 'utf8');

describe('CustomAgentNames', () => {
  it('maps each process name to its agent, re-reads a changed file, and keeps nothing it refuses', () => {
    let now = 0;
    const names = new CustomAgentNames(dir, () => now);
    const later = () => { now += 2_000; };
    expect(names.names().size).toBe(0);
    // Made-up CLIs. The second entry names a registry agent and is refused.
    write([{ name: 'Tern', command: '/opt/tern/bin/tern' }, { name: 'Mine', command: 'claude' }]);
    // One read answers for a moment: a labelled pane asks on every event.
    expect(names.names().size).toBe(0);
    later();
    expect([...names.names()]).toEqual([['tern', 'Tern']]);
    write([{ name: 'Gull', command: 'gull', processNames: ['gull', 'Gull-Daemon.exe'] }]);
    later();
    expect([...names.names()]).toEqual([['gull', 'Gull'], ['gull-daemon', 'Gull']]);
    fs.writeFileSync(path.join(dir, 'custom-agents.json'), '{ nope', 'utf8');
    later();
    expect(names.names().size).toBe(0);
  });
});
