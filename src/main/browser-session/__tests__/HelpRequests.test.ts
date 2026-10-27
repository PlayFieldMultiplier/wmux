import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HelpAlreadyPendingError,
  HelpRequests,
  type HelpProbeTarget,
} from '../HelpRequests';
import type { BrowserHelpProbe, BrowserHelpRequestInfo } from '../../../shared/browserHelp';

// browser_request_help — the store the whole feature hangs off. The clock is
// injected so the timeout path is exercised without fake timers, and the page is
// a fake so the completion rule is tested as a rule rather than through CDP.

interface Harness {
  store: HelpRequests;
  opened: BrowserHelpRequestInfo[];
  closed: string[];
  probe: ReturnType<typeof vi.fn<(record: HelpProbeTarget) => Promise<BrowserHelpProbe | null>>>;
  cleared: string[];
  setNow: (at: number) => void;
}

function harness(start = 1_000_000): Harness {
  let now = start;
  const opened: BrowserHelpRequestInfo[] = [];
  const closed: string[] = [];
  const cleared: string[] = [];
  const probe = vi.fn<(record: HelpProbeTarget) => Promise<BrowserHelpProbe | null>>(async () => null);
  let seq = 0;
  const store = new HelpRequests({
    open: (info) => opened.push(info),
    close: (requestId) => closed.push(requestId),
    probe,
    clearHighlight: async (record) => {
      cleared.push(record.requestId);
    },
    now: () => now,
    mintId: () => `req-${++seq}`,
  });
  return { store, opened, closed, probe, cleared, setNow: (at) => { now = at; } };
}

const base = { workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: 'Sign in, then press Done.' };

describe('HelpRequests.create', () => {
  it('opens a pending request, pushes the row, and stamps main\'s deadline', async () => {
    const h = harness(1_000);
    const info = h.store.create({ ...base, timeoutMs: 60_000 });

    expect(info.requestId).toBe('req-1');
    expect(info.deadlineAt).toBe(61_000);
    expect(h.opened).toEqual([info]);
    expect(await h.store.status(info.requestId, 'ws-1')).toEqual({ state: 'pending' });
  });

  it('sanitizes the agent-authored prompt and refuses an unusable one', () => {
    const h = harness();
    const info = h.store.create({ ...base, prompt: 'line one\nline\ttwo   ' });
    expect(info.prompt).toBe('line one line two');
    expect(() => h.store.create({ ...base, surfaceId: 'surf-2', prompt: `  ${String.fromCharCode(0)} ` })).toThrow(
      /1-500 printable characters/,
    );
  });

  it('clamps a timeout to the documented window and defaults an absent one', () => {
    const h = harness(0);
    expect(h.store.create({ ...base, timeoutMs: 5_000_000 }).deadlineAt).toBe(900_000);
    expect(h.store.create({ ...base, surfaceId: 'surf-2' }).deadlineAt).toBe(300_000);
    // Floored: a deadline the human cannot physically reach is not a hand-off,
    // and it could fire before the outline is even drawn.
    expect(h.store.create({ ...base, surfaceId: 'surf-3', timeoutMs: 1 }).deadlineAt).toBe(5_000);
  });

  it('allows one request per surface and refuses a second with the contract marker', () => {
    const h = harness();
    const first = h.store.create(base);
    let thrown: unknown;
    try {
      h.store.create({ ...base, prompt: 'another ask' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HelpAlreadyPendingError);
    expect((thrown as Error).message.startsWith('help_already_pending:')).toBe(true);
    expect((thrown as Error).message).toContain(first.requestId);
    // A DIFFERENT surface in the same workspace is unaffected — the slot is
    // per-surface, not per-workspace.
    expect(() => h.store.create({ ...base, surfaceId: 'surf-2' })).not.toThrow();
  });

  it('caps PENDING requests per workspace — a loop over fresh surface ids cannot arm timers without bound', async () => {
    const h = harness();
    // The per-surface slot is keyed on a caller-supplied id, so distinct ids
    // would otherwise open distinct pending rows forever.
    for (let i = 0; i < 8; i++) {
      h.store.create({ ...base, surfaceId: `surf-${i}` });
    }
    expect(() => h.store.create({ ...base, surfaceId: 'surf-overflow' })).toThrow(/already has 8 help requests open/);
    expect(h.opened).toHaveLength(8);
    // Another workspace is not throttled by this one.
    expect(() => h.store.create({ ...base, workspaceId: 'ws-2', surfaceId: 'surf-x' })).not.toThrow();
    // Settling one frees a slot.
    await h.store.cancel(h.opened[0].requestId, 'ws-1');
    expect(() => h.store.create({ ...base, surfaceId: 'surf-overflow' })).not.toThrow();
  });

  it('reclaims the slot of a holder whose deadline already passed', async () => {
    const h = harness(0);
    const stale = h.store.create({ ...base, timeoutMs: 1_000 });
    h.setNow(5_000);
    const fresh = h.store.create(base);
    expect(fresh.requestId).not.toBe(stale.requestId);
    expect((await h.store.status(stale.requestId, 'ws-1'))?.state).toBe('timed_out');
  });
});

describe('HelpRequests resolution', () => {
  it('records the human pressing Done as `continued` and closes the row', async () => {
    const h = harness();
    const info = h.store.create(base);
    expect(await h.store.resolveFromRenderer(info.requestId, 'continued')).toBe(true);
    expect(await h.store.status(info.requestId, 'ws-1')).toEqual({ state: 'continued' });
    expect(h.closed).toEqual([info.requestId]);
  });

  it('records Cancel as `cancelled`, and a second resolve keeps the first outcome', async () => {
    const h = harness();
    const info = h.store.create(base);
    await h.store.resolveFromRenderer(info.requestId, 'cancelled');
    expect(await h.store.resolveFromRenderer(info.requestId, 'continued')).toBe(false);
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('cancelled');
    expect(h.closed).toEqual([info.requestId]);
  });

  it('cancels from the agent side and frees the surface slot', async () => {
    const h = harness();
    const info = h.store.create(base);
    expect((await h.store.cancel(info.requestId, 'ws-1'))?.state).toBe('cancelled');
    expect(() => h.store.create(base)).not.toThrow();
  });

  it('takes a final URL reading and drops the outline on settle', async () => {
    const h = harness();
    h.probe.mockResolvedValue({ url: 'https://example.test/account', matched: false });
    const info = h.store.create({ ...base, ref: 'e7' });
    await h.store.resolveFromRenderer(info.requestId, 'continued');
    expect(await h.store.status(info.requestId, 'ws-1')).toEqual({
      state: 'continued',
      url: 'https://example.test/account',
    });
    expect(h.cleared).toEqual([info.requestId]);
  });

  it('omits url when the page cannot be read at all (chrome / external backend)', async () => {
    const h = harness();
    h.probe.mockResolvedValue(null);
    const info = h.store.create(base);
    await h.store.resolveFromRenderer(info.requestId, 'continued');
    expect(await h.store.status(info.requestId, 'ws-1')).toEqual({ state: 'continued' });
  });
});

describe('HelpRequests timeout', () => {
  it('settles as `timed_out` on the first status past the deadline', async () => {
    const h = harness(0);
    const info = h.store.create({ ...base, timeoutMs: 10_000 });
    h.setNow(9_999);
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
    h.setNow(10_000);
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('timed_out');
    expect(h.closed).toEqual([info.requestId]);
  });

  it('cannot be overwritten by a late human answer', async () => {
    const h = harness(0);
    const info = h.store.create({ ...base, timeoutMs: 10_000 });
    h.setNow(20_000);
    await h.store.status(info.requestId, 'ws-1');
    expect(await h.store.resolveFromRenderer(info.requestId, 'continued')).toBe(false);
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('timed_out');
  });
});

describe('HelpRequests completion criteria', () => {
  // Fake timers only here: the 500ms poller is the thing under test, and they
  // are handed back so the describes below keep the real clock.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-completes once the condition has held for the full hold window', async () => {
    let now = 0;
    const opened: BrowserHelpRequestInfo[] = [];
    const closed: string[] = [];
    let matched = false;
    const store = new HelpRequests({
      open: (info) => opened.push(info),
      close: (id) => closed.push(id),
      probe: async () => ({ url: 'https://example.test/dash', matched }),
      now: () => now,
      mintId: () => 'req-c',
    });
    const info = store.create({ ...base, completion: { urlIncludes: '/dash' } });

    // Not matched yet: polls do nothing.
    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.status(info.requestId, 'ws-1'))?.state).toBe('pending');

    // First matching poll only STARTS the hold — one frame of a redirect chain
    // must not complete the request.
    matched = true;
    now = 1_000;
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.status(info.requestId, 'ws-1'))?.state).toBe('pending');

    // Still inside the hold window.
    now = 1_500;
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.status(info.requestId, 'ws-1'))?.state).toBe('pending');

    // Held the full 1000ms.
    now = 2_000;
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.status(info.requestId, 'ws-1'))).toEqual({
      state: 'completed',
      url: 'https://example.test/dash',
    });
    expect(closed).toEqual([info.requestId]);
  });

  it('restarts the hold when the condition stops holding', async () => {
    let now = 0;
    let matched = true;
    const store = new HelpRequests({
      open: () => {},
      close: () => {},
      probe: async () => ({ url: 'https://example.test/x', matched }),
      now: () => now,
      mintId: () => 'req-r',
    });
    const info = store.create({ ...base, completion: { selector: '#done' } });

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    matched = false;
    now = 1_000;
    await vi.advanceTimersByTimeAsync(500);
    matched = true;
    now = 1_500;
    await vi.advanceTimersByTimeAsync(500);
    // The run restarted at 1500, so 2000 is only 500ms in — still pending.
    now = 2_000;
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
  });

  it('does not poll at all when no completion criteria were given', async () => {
    const probe = vi.fn(async () => ({ url: 'https://example.test/', matched: true }));
    const store = new HelpRequests({
      open: () => {},
      close: () => {},
      probe,
      mintId: () => 'req-n',
    });
    store.create(base);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('HelpRequests workspace scoping', () => {
  it('answers another workspace exactly as it answers an unknown id', async () => {
    const h = harness();
    const info = h.store.create(base);
    expect(await h.store.status(info.requestId, 'ws-2')).toBeNull();
    expect(await h.store.status('no-such-id', 'ws-1')).toBeNull();
    expect(await h.store.cancel(info.requestId, 'ws-2')).toBeNull();
    // …and the refusal changed nothing.
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
  });

  it('refuses an empty workspace id rather than treating it as a wildcard', async () => {
    const h = harness();
    const info = h.store.create(base);
    expect(await h.store.status(info.requestId, '')).toBeNull();
  });

  it('keeps two workspaces\' requests independent', async () => {
    const h = harness();
    const a = h.store.create(base);
    const b = h.store.create({ ...base, workspaceId: 'ws-2' });
    await h.store.cancel(a.requestId, 'ws-1');
    expect((await h.store.status(b.requestId, 'ws-2'))?.state).toBe('pending');
  });
});

describe('HelpRequests on the phone', () => {
  it('listPending reports the open requests in their phone shape, oldest first', async () => {
    const h = harness(5_000);
    const a = h.store.create({ ...base, timeoutMs: 60_000 });
    const b = h.store.create({ workspaceId: 'ws-2', prompt: 'Approve the payment.', timeoutMs: 30_000 });
    await h.store.cancel(a.requestId, 'ws-1');
    const c = h.store.create({ ...base, surfaceId: 'surf-3', timeoutMs: 10_000 });
    expect(h.store.listPending()).toEqual([
      { requestId: b.requestId, workspaceId: 'ws-2', surfaceId: undefined, prompt: 'Approve the payment.', createdAt: 5_000, deadlineAt: 35_000 },
      { requestId: c.requestId, workspaceId: 'ws-1', surfaceId: 'surf-3', prompt: base.prompt, createdAt: 5_000, deadlineAt: 15_000 },
    ]);
  });

  it('listPending settles and leaves out a request whose deadline passed', async () => {
    const h = harness(1_000);
    const info = h.store.create({ ...base, timeoutMs: 10_000 });
    h.setNow(11_000);
    expect(h.store.listPending()).toEqual([]);
    expect(await h.store.status(info.requestId, 'ws-1')).toEqual({ state: 'timed_out' });
  });

  it('resolveFromPhone settles only in the workspace that owns the request', async () => {
    const h = harness();
    const info = h.store.create(base);
    expect(await h.store.resolveFromPhone('ws-2', info.requestId, 'continued')).toEqual({ ok: false, reason: 'not-found' });
    expect(await h.store.resolveFromPhone('ws-1', 'req-unknown', 'continued')).toEqual({ ok: false, reason: 'not-found' });
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
    expect(await h.store.resolveFromPhone('ws-1', info.requestId, 'continued')).toEqual({ ok: true, state: 'continued' });
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('continued');
    await vi.waitFor(() => expect(h.closed).toEqual([info.requestId]), { timeout: 5_000 });
  });

  it('resolveFromPhone answers closed for an expired request, and settles it timed_out first', async () => {
    const h = harness(1_000);
    const info = h.store.create({ ...base, timeoutMs: 10_000 });
    h.setNow(11_000);
    expect(await h.store.resolveFromPhone('ws-1', info.requestId, 'continued')).toEqual({ ok: false, reason: 'closed' });
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('timed_out');
  });

  it('the first answer wins: the desktop then the phone, and two phones at once', async () => {
    const h = harness();
    const a = h.store.create(base);
    expect(await h.store.resolveFromRenderer(a.requestId, 'cancelled')).toBe(true);
    expect(await h.store.resolveFromPhone('ws-1', a.requestId, 'continued')).toEqual({ ok: false, reason: 'closed' });
    expect((await h.store.status(a.requestId, 'ws-1'))?.state).toBe('cancelled');

    const b = h.store.create({ ...base, surfaceId: 'surf-2' });
    const [first, second] = await Promise.all([
      h.store.resolveFromPhone('ws-1', b.requestId, 'continued'),
      h.store.resolveFromPhone('ws-1', b.requestId, 'cancelled'),
    ]);
    expect(first).toEqual({ ok: true, state: 'continued' });
    expect(second).toEqual({ ok: false, reason: 'closed' });
    expect((await h.store.status(b.requestId, 'ws-1'))?.state).toBe('continued');
    expect(h.store.listSettled()).toEqual([
      { requestId: a.requestId, state: 'cancelled' },
      { requestId: b.requestId, state: 'continued' },
    ]);
  });

  it('resolveFromPhone answers without waiting for a slow page', async () => {
    const h = harness();
    const info = h.store.create(base);
    h.probe.mockImplementation(() => new Promise(() => undefined));
    expect(await h.store.resolveFromPhone('ws-1', info.requestId, 'cancelled')).toEqual({ ok: true, state: 'cancelled' });
    expect((await h.store.status(info.requestId, 'ws-1'))?.state).toBe('cancelled');
  });

  it('onChange fires on open and on settle, after the change is visible', async () => {
    const h = harness();
    const seen: number[] = [];
    const off = h.store.onChange(() => seen.push(h.store.listPending().length));
    const info = h.store.create(base);
    await h.store.resolveFromPhone('ws-1', info.requestId, 'continued');
    off();
    h.store.create({ ...base, surfaceId: 'surf-2' });
    expect(seen).toEqual([1, 0]);
  });
});
