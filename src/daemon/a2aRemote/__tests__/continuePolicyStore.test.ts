// This PC's continue policy: off both ways until saved, a save that read an
// old version changes nothing, and what is saved is what a reload reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTINUE_POLICY_FILE, ContinuePolicyStore } from '../continuePolicyStore';

const HOST = '11111111-1111-4111-8111-111111111111';
let dir: string;
const open = (): ContinuePolicyStore => new ContinuePolicyStore({ dir, scheduleHarden: () => undefined });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-policy-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ContinuePolicyStore', () => {
  it('starts off both ways; a save bumps the version and survives a reload; a stale save is a conflict', () => {
    const store = open();
    expect(store.get()).toMatchObject({ in: { enabled: false }, out: {}, version: 0 });
    const saved = store.set({ v: 1, in: { enabled: true, permissionMode: 'bypassPermissions' }, out: { [HOST]: { allowed: true } }, version: 0 });
    // A mode that skips the agent's permission checks is never taken.
    expect(saved).toMatchObject({ ok: true, policy: { in: { enabled: true, permissionMode: 'auto' }, version: 1 } });
    expect(open().get()).toMatchObject({ in: { enabled: true }, out: { [HOST]: { allowed: true } }, version: 1 });
    expect(store.set({ v: 1, in: { enabled: false }, version: 0 })).toMatchObject({ ok: false, conflict: true });
    expect(store.set({ v: 2 })).toMatchObject({ ok: false });
    expect(store.get().in.enabled).toBe(true);
  });

  it('a removed PC loses its send allow, in memory and on disk; retaining keeps only paired PCs', () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const store = open();
    store.set({ v: 1, in: { enabled: true }, out: { [HOST]: { allowed: true }, [OTHER]: { allowed: true } }, version: 0 });
    expect(store.forgetHost(HOST)).toBe(true);
    expect(store.get().out).toEqual({ [OTHER]: { allowed: true } });
    expect(open().get()).toMatchObject({ out: { [OTHER]: { allowed: true } }, version: 2 });
    expect(store.forgetHost(HOST)).toBe(false);
    expect(open().retainHosts((h) => h === HOST)).toBe(true);
    expect(open().get().out).toEqual({});
  });

  it('a file that is not a policy reads as off, and is kept aside', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONTINUE_POLICY_FILE), JSON.stringify({ v: 9, in: { enabled: true } }));
    expect(open().get().in.enabled).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${CONTINUE_POLICY_FILE}.corrupt-`))).toBe(true);
  });
});
