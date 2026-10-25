import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesHost } from '../hermesHost';
import { hermesRoot, type HermesRun } from '../hermesEngine';

// The gateway of wmux's Hermes home: a gateway wmux did not see start is
// restarted before a bot attaches; on quit only a gateway wmux started is
// stopped, by Hermes's own stop and then its PID.
describe('HermesHost gateway', () => {
  let dir: string;
  let alive: Set<number>;
  let calls: string[][];
  let killed: number[];
  let stopWorks: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-host-'));
    alive = new Set();
    calls = [];
    killed = [];
    stopWorks = true;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeGateway = (pid: number, argv = ['python', '-m', 'hermes_cli.main', 'gateway', 'run', '--quiet', '--idle-exit']): void => {
    const root = hermesRoot(dir);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'gateway_state.json'), JSON.stringify({ pid, argv, hermes_home: root, platforms: {} }));
    alive.add(pid);
  };
  const host = (): HermesHost => {
    const run: HermesRun = async (_exe, args) => {
      calls.push(args);
      if (args[0] === 'gateway' && args[1] === 'stop' && stopWorks) alive.clear();
      return { code: 0, stdout: '', stderr: '' };
    };
    return new HermesHost({
      wmuxDir: () => dir,
      resolveExe: () => '/bin/hermes',
      run,
      pidAlive: (pid) => alive.has(pid),
      kill: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      log: () => undefined,
    });
  };
  const stops = (): number => calls.filter((a) => a[0] === 'gateway' && a[1] === 'stop').length;

  it('restarts a gateway wmux did not start, or one that will not idle out, and keeps its own', async () => {
    writeGateway(101);
    const h = host();
    await h.ensureOwnGateway();
    expect(stops()).toBe(1);

    writeGateway(102);
    h.markOwned();
    await h.ensureOwnGateway();
    expect(stops()).toBe(1);

    writeGateway(103, ['python', '-m', 'hermes_cli.main', 'gateway', 'run']);
    h.markOwned();
    await h.ensureOwnGateway();
    expect(stops()).toBe(2);

    // A bot's agent attached: its gateway is in use and kept.
    const other = host();
    other.register({ agentLive: () => true } as never);
    writeGateway(104);
    await other.ensureOwnGateway();
    expect(stops()).toBe(2);
  });

  it('on quit stops only a gateway it started, signalling it when Hermes\'s stop does not', async () => {
    writeGateway(201);
    await host().shutdown();
    expect(stops()).toBe(0);
    expect(alive.has(201)).toBe(true);

    stopWorks = false;
    const h = host();
    h.markOwned();
    await h.shutdown();
    expect(stops()).toBe(1);
    expect(killed).toEqual([201]);
  });
});
