// #2388: a task folder whose removal did not finish takes no new pane. Both
// of main's create paths, and the daemon's own (a phone's, an automation's
// pane), check the lock before a session exists.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('the pending-removal lock on pane creation', () => {
  it('main\'s daemon create checks it before the session is asked for', () => {
    const src = read('src/main/ipc/handlers/pty.handler.ts');
    const check = src.indexOf('pendingRemovalRefusal(cwdResolution.safeCwd)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("daemonClient.rpc('daemon.createSession'"));
  });

  it('main\'s local create checks it before the PTY is spawned', () => {
    const src = read('src/main/ipc/handlers/pty.handler.ts');
    const first = src.indexOf('pendingRemovalRefusal(cwdResolution.safeCwd)');
    const second = src.indexOf('pendingRemovalRefusal(cwdResolution.safeCwd)', first + 1);
    expect(second).toBeGreaterThan(first);
    const spawn = src.indexOf('await ptyManager.createAsync(');
    expect(spawn).toBeGreaterThan(second);
    // The second check belongs to the local path: no other create runs between.
    expect(src.slice(second, spawn)).not.toContain("daemonClient.rpc('daemon.createSession'");
  });

  it('the daemon\'s createSession checks it before the session is created', () => {
    const src = read('src/daemon/index.ts');
    // In the form the spawn uses: `~/` expanded as prepareSpawn does.
    const check = src.indexOf('pendingRemovalRefusalAt(getWmuxDir(), p.cwd ? expandTilde(p.cwd) : p.cwd');
    expect(check).toBeGreaterThan(-1);
    const create = src.indexOf('sessionManager.createSessionAsync({', check);
    expect(create).toBeGreaterThan(check);
    expect(src.slice(check, create)).toContain('if (pendingRefusal) throw new Error(pendingRefusal);');
  });
});
