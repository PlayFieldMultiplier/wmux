// The act outbox: one row per request, journaled before a write, an inFlight
// row found on load is uncertain, a try given back is not counted, and a
// file it cannot read is refused rather than dropped. The payload rules the
// card and the phone share (actPayload.ts) are checked here too.

import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACT_MAX_ATTEMPTS, ActEffectStore, actEffectId } from '../actEffectStore';
import { actTextProblem, normalizeActText, payloadFence, payloadHashOf } from '../actPayload';

const ID = 'apr-aaaaaaaaaaaa';
let dir = '';
let file = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-act-store-'));
  file = path.join(dir, 'factory', 'act-effects.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const input = { requestId: ID, action: 'comment' as const, repoKey: 'github.com/o/r', payloadHash: 'h' };

describe('the act outbox', () => {
  it('one row per request; a claim is on disk before the write; an inFlight row loads as uncertain', () => {
    const s = new ActEffectStore(file);
    const row = s.enqueue(input);
    expect(s.enqueue({ ...input, payloadHash: 'other' })).toBe(row);
    expect(s.claim(actEffectId(ID))).toMatchObject({ status: 'inFlight', attempt: 1 });
    const again = new ActEffectStore(file);
    expect(again.get(actEffectId(ID))).toMatchObject({ status: 'uncertain', reason: 'restart-mid-write' });
    expect(again.claim(actEffectId(ID))).toBeNull();
  });

  it('a try given back is not counted; tries run out into a refusal', () => {
    const s = new ActEffectStore(file);
    s.enqueue(input);
    const id = actEffectId(ID);
    s.claim(id);
    expect(s.release(id, 'rate-limited')).toMatchObject({ status: 'pending', attempt: 0 });
    for (let i = 0; i < ACT_MAX_ATTEMPTS; i += 1) {
      s.claim(id);
      s.finish(id, 'uncertain', 'write-error');
      s.settle(id, 'pending', 'not-found');
    }
    expect(s.get(id)).toMatchObject({ status: 'refused', reason: 'attempts-exhausted' });
  });

  it('a release\'s draft id is journaled while its row is claimed or being settled, and kept through the moves after', () => {
    const s = new ActEffectStore(file);
    const id = actEffectId(ID);
    s.enqueue({ ...input, action: 'release' });
    s.claim(id);
    expect(s.noteDraft(id, 0)).toBeNull();
    expect(s.noteDraft(id, 42)).toMatchObject({ status: 'inFlight', draftId: 42 });
    // A restart mid-write: the id is on disk with the uncertain row.
    const again = new ActEffectStore(file);
    expect(again.get(id)).toMatchObject({ status: 'uncertain', draftId: 42 });
    expect(again.settle(id, 'pending', 'not-found')).toMatchObject({ status: 'pending', draftId: 42 });
    expect(again.claim(id)).toMatchObject({ status: 'inFlight', draftId: 42 });
    expect(again.finish(id, 'done', undefined, { url: 'https://github.com/o/r/releases/tag/v1', id: 42 })).toMatchObject({ status: 'done', draftId: 42 });
    expect(again.noteDraft(id, 43)).toBeNull();
  });

  it('a malformed file is refused; a row of an act this build does not know is kept and never run', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, effects: [{ id: 'x' }] }));
    expect(() => new ActEffectStore(file)).toThrow(/Invalid act effect entry/);
    const future = { ...input, action: 'release_later', id: actEffectId(ID), status: 'pending', attempt: 0, createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, effects: [future] }));
    const s = new ActEffectStore(file);
    expect(s.get(actEffectId(ID))).toMatchObject({ action: 'release_later' });
    expect(s.claim(actEffectId(ID))).toBeNull();
  });

  it('a row that may have run is not removed with its request', () => {
    const s = new ActEffectStore(file);
    s.enqueue(input);
    s.claim(actEffectId(ID));
    s.finish(actEffectId(ID), 'uncertain', 'write-error');
    s.remove(actEffectId(ID));
    expect(s.get(actEffectId(ID))).not.toBeNull();
  });

  it('a try given back that cannot be journaled is uncertain, never left inFlight', () => {
    const s = new ActEffectStore(file);
    s.enqueue(input);
    const id = actEffectId(ID);
    s.claim(id);
    const realWrite = fsDefault.writeFileSync;
    const spy = vi.spyOn(fsDefault, 'writeFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof f === 'string' && path.dirname(f) === path.dirname(file)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (realWrite as (...a: unknown[]) => void)(f, ...rest);
    }) as typeof fsDefault.writeFileSync);
    try {
      expect(s.release(id, 'rate-limited')).toMatchObject({ status: 'uncertain', reason: 'write-failed' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(s.get(id)).toMatchObject({ status: 'uncertain', reason: 'write-failed', attempt: 1 });
  });
});

describe('the payload rules', () => {
  it('normalises line ends and the end, and refuses what the card would not show as posted', () => {
    expect(normalizeActText('a\r\nb\rc  \n\n')).toBe('a\nb\nc');
    const same = (t: string) => t;
    expect(actTextProblem('fine\ttext\nhere', same)).toBeNull();
    expect(actTextProblem('zero\u200bwidth', same)).toMatch(/zero-width/);
    expect(actTextProblem('bell\u0007', same)).toMatch(/control/);
    expect(actTextProblem('x <!-- Wmux-Approval:apr-1 -->', same)).toMatch(/wmux-approval/);
    expect(actTextProblem('token abc', (t) => t.replace('abc', '***'))).toMatch(/secret/);
  });

  it('a fence is longer than any backtick or tilde run in its text', () => {
    expect(payloadFence('plain')).toBe('```');
    expect(payloadFence('has ``` and ~~~~~ runs')).toBe('``````');
    expect(payloadHashOf(['a', 'b'])).toBe(payloadHashOf(['a\u0000b']));
    expect(payloadHashOf(['a', 'b'])).not.toBe(payloadHashOf(['ab']));
  });
});
