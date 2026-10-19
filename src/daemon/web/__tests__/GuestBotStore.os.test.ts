import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_LIMITS, parseGuestCredential } from '../../../shared/guestBots';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { GUEST_BOTS_FILE, GuestBotStore, GuestStoreError, type GuestBotStoreOptions } from '../GuestBotStore';

const DM = { workspaceId: 'ws-1', threadId: 'dm:bot-0000aaaa' };
const GROUP = { workspaceId: 'ws-1', threadId: 'group:grp-0000bbbb' };

let dir: string;
let fail = false;
let clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<GuestBotStoreOptions> = {}): GuestBotStore =>
  new GuestBotStore({ dir, now: () => clock, scheduleHarden: () => undefined, write: flakyWrite, ...o });
const secretOf = (token: string): { guestId: string; secret: string } => parseGuestCredential(token)!;

beforeEach(() => {
  fail = false;
  clock = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-bots-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GuestBotStore', () => {
  it('is off by default, and the switch persists', () => {
    const s = make();
    expect(s.enabled()).toBe(false);
    s.setEnabled(true);
    expect(make().enabled()).toBe(true);
    s.setEnabled(false);
    expect(make().enabled()).toBe(false);
  });

  it('create hands out a well-formed token once and never writes the secret', async () => {
    const s = make();
    const { guest, token } = await s.create({ name: '  Grok   Bot ', scope: DM });
    const cred = secretOf(token);
    expect(cred.guestId).toBe(guest.guestId);
    expect(Buffer.from(cred.secret, 'base64url')).toHaveLength(32);
    expect(guest).toMatchObject({ v: 1, name: 'Grok Bot', scope: DM });
    const raw = fs.readFileSync(path.join(dir, GUEST_BOTS_FILE), 'utf-8');
    expect(raw).not.toContain(cred.secret);
    expect(JSON.stringify(s.list())).not.toMatch(/secretHash|salt|kdf/);
  });

  it('resolves the right secret with its stored scope, also from a fresh instance', async () => {
    const s = make();
    const { token } = await s.create({ name: 'Grok', scope: GROUP });
    const { guestId, secret } = secretOf(token);
    expect(await s.resolve(guestId, secret)).toEqual({ ok: true, guestId, name: 'Grok', scope: GROUP });
    expect(s.stats().derivations).toBe(0);
    const again = make();
    expect(await again.resolve(guestId, secret)).toMatchObject({ ok: true, scope: GROUP });
    expect(again.stats().derivations).toBe(1);
  });

  it('a wrong secret is unknown, and past the budget no derivation runs', async () => {
    const s = make();
    const { token } = await s.create({ name: 'Grok', scope: DM });
    const { guestId, secret } = secretOf(token);
    const fresh = make();
    for (let i = 0; i < GUEST_LIMITS.failuresPerWindow; i++) {
      expect(await fresh.resolve(guestId, 'B'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });
    }
    const spent = fresh.stats().derivations;
    expect(await fresh.resolve(guestId, secret)).toEqual({ ok: false, reason: 'unknown' });
    expect(fresh.stats().derivations).toBe(spent);
    clock += GUEST_LIMITS.failureWindowMs;
    expect(await fresh.resolve(guestId, secret)).toMatchObject({ ok: true });
  });

  it('revoke is immediate, survives a restart, and a failed write still refuses', async () => {
    const s = make();
    const a = secretOf((await s.create({ name: 'A', scope: DM })).token);
    const b = secretOf((await s.create({ name: 'B', scope: DM })).token);
    expect(s.revoke(a.guestId)).toBe(true);
    expect(await s.resolve(a.guestId, a.secret)).toEqual({ ok: false, reason: 'revoked' });
    expect(await make().resolve(a.guestId, a.secret)).toEqual({ ok: false, reason: 'revoked' });
    expect(s.revoke(a.guestId)).toBe(false);
    fail = true;
    expect(() => s.revoke(b.guestId)).toThrow('disk full');
    expect(await s.resolve(b.guestId, b.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a bad name or a scope that is not a conversation', async () => {
    const s = make();
    await expect(s.create({ name: '   ', scope: DM })).rejects.toBeInstanceOf(GuestStoreError);
    for (const threadId of ['pr:github.com/o/r#1', 'task:abc', 'nonsense']) {
      await expect(s.create({ name: 'X', scope: { workspaceId: 'ws-1', threadId } })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(s.create({ name: 'X', scope: { workspaceId: '../x', threadId: 'general' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('caps live guests; a revoked one frees its place', async () => {
    const s = make();
    const ids: string[] = [];
    for (let i = 0; i < GUEST_LIMITS.liveMax; i++) ids.push((await s.create({ name: `G${i}`, scope: DM })).guest.guestId);
    await expect(s.create({ name: 'one more', scope: DM })).rejects.toMatchObject({ code: 'too-many' });
    s.revoke(ids[0]!);
    await expect(s.create({ name: 'one more', scope: DM })).resolves.toMatchObject({ guest: { name: 'one more' } });
  });

  it('a create whose write fails hands out nothing', async () => {
    const s = make();
    fail = true;
    await expect(s.create({ name: 'Grok', scope: DM })).rejects.toThrow('disk full');
    expect(s.list()).toEqual([]);
  });

  it('a corrupt file starts empty and off, keeping the original aside', async () => {
    const s = make();
    s.setEnabled(true);
    await s.create({ name: 'Grok', scope: DM });
    const file = path.join(dir, GUEST_BOTS_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.guests[0].kdf.N = 3;
    fs.writeFileSync(file, JSON.stringify(raw));
    const again = make();
    expect(again.enabled()).toBe(false);
    expect(again.list()).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${GUEST_BOTS_FILE}.corrupt-`))).toBe(true);
  });

  it('touch records lastSeenAt, persisted at most once a minute', async () => {
    const s = make();
    const { guest } = await s.create({ name: 'Grok', scope: DM });
    clock += 61_000;
    s.touch(guest.guestId);
    expect(make().list()[0]?.lastSeenAt).toBe(new Date(clock).toISOString());
  });
});
