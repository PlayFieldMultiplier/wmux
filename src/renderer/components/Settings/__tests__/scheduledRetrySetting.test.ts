import { describe, expect, it } from 'vitest';
import type { AutomationSettings, AutomationSettingsResult } from '../../../../shared/automation';
import { scheduledRetrySync } from '../scheduledRetrySetting';

/** A deferred promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig() {
  const reads: Array<ReturnType<typeof deferred<AutomationSettings | null>>> = [];
  const writes: Array<{ value: boolean; d: ReturnType<typeof deferred<AutomationSettingsResult>> }> = [];
  const shown: Array<boolean | null> = [];
  const sync = scheduledRetrySync({
    read: () => { const d = deferred<AutomationSettings | null>(); reads.push(d); return d.promise; },
    write: (value) => { const d = deferred<AutomationSettingsResult>(); writes.push({ value, d }); return d.promise; },
  }, (v) => shown.push(v));
  return { sync, reads, writes, shown, last: () => shown[shown.length - 1] };
}

describe('scheduledRetrySync', () => {
  it('stays unknown while the daemon has no answer, and takes the value from a later read on reconnect', async () => {
    const r = rig();
    r.sync.read();
    r.reads[0].resolve(null);
    await flush();
    expect(r.last()).toBeNull();
    // The daemon (re)connected: the row reads again.
    r.sync.read();
    r.reads[1].resolve({ retryTransientErrors: false });
    await flush();
    expect(r.last()).toBe(false);
  });

  it('a write that errors leaves the value unknown and reads it again instead of assuming the old one', async () => {
    const r = rig();
    r.sync.read();
    r.reads[0].resolve({ retryTransientErrors: true });
    await flush();
    r.sync.change(false);
    expect(r.last()).toBe(false);
    // The RPC timed out, though the daemon may have saved it.
    r.writes[0].d.reject(new Error('timeout'));
    await flush();
    expect(r.shown.slice(-1)).toEqual([null]);
    expect(r.reads).toHaveLength(2);
    r.reads[1].resolve({ retryTransientErrors: false });
    await flush();
    expect(r.last()).toBe(false);
  });

  it('a refused write is unknown and re-read too; a saved one shows what the daemon saved', async () => {
    const r = rig();
    r.sync.change(false);
    r.writes[0].d.resolve({ ok: false, error: 'Could not save the settings' });
    await flush();
    expect(r.last()).toBeNull();
    r.reads[0].resolve({ retryTransientErrors: true });
    await flush();
    expect(r.last()).toBe(true);
    r.sync.change(false);
    r.writes[1].d.resolve({ ok: true, settings: { retryTransientErrors: false } });
    await flush();
    expect(r.last()).toBe(false);
  });

  it('only the newest request is shown, and nothing after dispose', async () => {
    const r = rig();
    r.sync.change(false);
    r.sync.change(true);
    r.writes[1].d.resolve({ ok: true, settings: { retryTransientErrors: true } });
    r.writes[0].d.reject(new Error('late'));
    await flush();
    expect(r.last()).toBe(true);
    expect(r.reads).toHaveLength(0);
    r.sync.read();
    r.sync.dispose();
    r.reads[0].resolve({ retryTransientErrors: false });
    await flush();
    expect(r.last()).toBe(true);
  });
});
