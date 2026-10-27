import { describe, expect, it } from 'vitest';
import {
  BROWSER_HELP_PARK_PREFIX,
  BrowserHelpPushRouter,
  browserHelpPushAudience,
  browserHelpPushCollapseId,
  buildBrowserHelpPushPayload,
  buildBrowserHelpRetractionPayload,
} from '../browserHelpPush';
import { BrowserHelpTable } from '../../phone/BrowserHelpTable';
import type { PushTarget } from '../PushSender';
import type { PushPayload } from '../../../shared/push/pushEnvelope';
import type { BrowserHelpTableRow } from '../../../shared/phoneBrowserHelp';

// A browser help request as a phone push: who gets it, what it says, and that
// the daemon's table republishing never pushes it twice.

const PROMPT = 'Sign in to the shop with your card ending 4242, then press Done.';

const row = (over: Partial<BrowserHelpTableRow> = {}): BrowserHelpTableRow => ({
  requestId: 'req-1', workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: PROMPT,
  createdAt: 1_000, deadlineAt: 61_000, backend: 'builtin', previewable: true, ...over,
});

type Sent = { payload: PushPayload; opts: { collapseId: string; requires: string; deviceIds: readonly string[] } };

function harness(opts: { audience?: string[]; present?: boolean; brain?: (id: string) => boolean } = {}) {
  const sent: Sent[] = [];
  const parked: Array<{ key: string; deviceIds: readonly string[] }> = [];
  const forgotten: string[] = [];
  const clock = { now: 2_000 };
  const state = { audience: opts.audience ?? ['phone-1'], present: opts.present ?? false, owner: 'main' };
  const router = new BrowserHelpPushRouter({
    audience: () => state.audience,
    isBrainPane: opts.brain ?? (() => false),
    suppress: () => state.present,
    send: (payload, o) => sent.push({ payload, opts: o }),
    park: (key, _payload, _collapseId, _requires, deviceIds) => parked.push({ key, deviceIds }),
    forget: (key) => forgotten.push(key),
    now: () => clock.now,
  });
  const table = new BrowserHelpTable({
    firstParty: () => true,
    isOwner: (id) => id === state.owner,
    emit: () => undefined,
    onRows: (rows, closed) => router.set(rows, closed),
    now: () => clock.now,
  });
  return { router, table, sent, parked, forgotten, clock, state };
}

describe('browser help push payloads', () => {
  it('★ the sealed body is fixed text: no prompt, no approvalId', () => {
    const payload = buildBrowserHelpPushPayload(row());
    expect(payload).toEqual({
      title: 'Browser help needed',
      body: 'An agent is waiting for you to finish a step in the browser.',
      approvalKind: 'browser_help',
      browserHelpId: 'req-1',
      workspaceId: 'ws-1',
      surfaceId: 'surf-1',
      requiresInAppChoice: true,
    });
    expect(JSON.stringify(payload)).not.toContain('4242');
    expect('approvalId' in payload).toBe(false);
    expect('surfaceId' in buildBrowserHelpPushPayload(row({ surfaceId: undefined }))).toBe(false);
  });

  it('collapses on bh-<requestId>', () => {
    expect(browserHelpPushCollapseId('5d0e9b82-1111-2222-3333-444455556666')).toBe('bh-5d0e9b82-1111-2222-3333-444455556666');
  });

  it('★ the retraction names the request and how it ended, for each resolution', () => {
    for (const resolution of ['completed', 'continued', 'cancelled', 'timed_out'] as const) {
      const payload = buildBrowserHelpRetractionPayload('req-1', 'ws-1', resolution);
      expect(payload).toEqual({
        title: 'Browser help closed',
        body: 'No longer waiting — nothing to do.',
        kind: 'approval_retraction',
        approvalKind: 'browser_help',
        retractsApprovalId: 'req-1',
        workspaceId: 'ws-1',
        resolution,
      });
      expect('approvalId' in payload || 'browserHelpId' in payload).toBe(false);
    }
  });
});

describe('browserHelpPushAudience', () => {
  const target = (deviceId: string, capabilities?: string[]): PushTarget => ({
    deviceId, name: deviceId, push: { apnsToken: 'a'.repeat(64), publicKey: 'k', ...(capabilities ? { capabilities } : {}) },
  });
  const targets = [
    target('granted', ['browserHelpPush']),
    target('no-capability', ['botPromptPush']),
    target('old-app'),
    target('read-only', ['browserHelpPush']),
    target('legacy-grant', ['browserHelpPush']),
  ];
  // `hasExplicitInputGrant` is false for a read-only device and for one whose
  // grant was never set (a record from before grants existed).
  const explicit = (id: string) => id === 'granted' || id === 'no-capability' || id === 'old-app';
  const server = { allowInput: true, allowTranscript: true };

  it('★ only a device with the capability and an explicit input grant', () => {
    expect(browserHelpPushAudience({ server, targets, hasExplicitInputGrant: explicit })).toEqual(['granted']);
  });

  it('★ nobody without the transcript consent, on a read-only server, or with no server', () => {
    expect(browserHelpPushAudience({ server: { allowInput: true, allowTranscript: false }, targets, hasExplicitInputGrant: explicit })).toEqual([]);
    expect(browserHelpPushAudience({ server: { allowInput: false, allowTranscript: true }, targets, hasExplicitInputGrant: explicit })).toEqual([]);
    expect(browserHelpPushAudience({ server: undefined, targets, hasExplicitInputGrant: explicit })).toEqual([]);
  });
});

describe('BrowserHelpPushRouter', () => {
  it('★ pushes an opened request once, to the audience, and retracts it to the same devices', () => {
    const h = harness({ audience: ['phone-1', 'phone-2'] });
    h.table.set('main', { requests: [row()] });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].opts).toEqual({ collapseId: 'bh-req-1', requires: 'browserHelpPush', deviceIds: ['phone-1', 'phone-2'] });
    // The audience moved since: the retraction still goes where the push went.
    h.state.audience = ['phone-3'];
    h.table.set('main', { requests: [], closed: [{ requestId: 'req-1', state: 'completed' }] });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].opts).toEqual({ collapseId: 'bh-req-1', requires: 'browserHelpPush', deviceIds: ['phone-1', 'phone-2'] });
    expect(h.sent[1].payload).toMatchObject({ kind: 'approval_retraction', retractsApprovalId: 'req-1', workspaceId: 'ws-1', resolution: 'completed' });
  });

  it('★ a decision taken through this daemon retracts with its outcome', () => {
    const h = harness();
    h.table.set('main', { requests: [row()] });
    h.table.closeDecided('req-1', 'continued');
    expect(h.sent.map((s) => s.payload.resolution)).toEqual([undefined, 'continued']);
  });

  it('★ nobody to push to: nothing sent, and nothing to retract', () => {
    const h = harness({ audience: [] });
    h.table.set('main', { requests: [row()] });
    h.table.set('main', { requests: [] });
    expect(h.sent).toEqual([]);
  });

  it('★ a brain pane\'s request is never pushed', () => {
    const h = harness({ brain: (id) => id === 'brain-pty' });
    h.table.set('main', { requests: [row({ requesterPtyId: 'brain-pty' })] });
    h.table.set('main', { requests: [] });
    expect(h.sent).toEqual([]);
  });

  it('★ a republish, a reconnect or a stale table never pushes again', () => {
    const h = harness();
    h.table.set('main', { requests: [row()] });
    h.table.set('main', { requests: [row()] });
    // The desktop goes away and comes back with the same request open.
    h.router.forgetParked();
    h.table.onClientClose('main');
    h.state.owner = 'main-2';
    h.table.set('main-2', { requests: [row()] });
    expect(h.sent).toHaveLength(1);
    // Closed, then a table computed before that lists it again.
    h.table.set('main-2', { requests: [], closed: [{ requestId: 'req-1', state: 'timed_out' }] });
    h.table.set('main-2', { requests: [row()] });
    expect(h.sent.map((s) => s.payload.kind ?? 'push')).toEqual(['push', 'approval_retraction']);
  });

  it('★ a row that leaves with no state still retracts', () => {
    const h = harness();
    h.table.set('main', { requests: [row(), row({ requestId: 'req-2', deadlineAt: 3_000 })] });
    h.table.onClientClose('main');
    h.state.owner = 'main-2';
    h.clock.now = 4_000;
    // The new desktop no longer has either: one before its deadline, one after.
    h.table.set('main-2', { requests: [] });
    expect(h.sent.slice(2).map((s) => [s.payload.retractsApprovalId, s.payload.resolution])).toEqual([
      ['req-1', 'cancelled'],
      ['req-2', 'timed_out'],
    ]);
  });

  it('does not push a request already past its deadline', () => {
    const h = harness();
    h.clock.now = 70_000;
    expect(h.table.set('main', { requests: [row()] })).toMatchObject({ ok: true });
    expect(h.sent).toEqual([]);
  });

  it('a held push carries its devices; closed while held it is forgotten, not retracted', () => {
    const h = harness({ present: true });
    h.table.set('main', { requests: [row()] });
    expect(h.parked).toEqual([{ key: `${BROWSER_HELP_PARK_PREFIX}req-1`, deviceIds: ['phone-1'] }]);
    h.table.set('main', { requests: [] });
    expect(h.forgotten).toEqual([`${BROWSER_HELP_PARK_PREFIX}req-1`]);
    expect(h.sent).toEqual([]);
  });

  it('a held push released by presence is retracted later', () => {
    const h = harness({ present: true });
    h.table.set('main', { requests: [row()] });
    expect(h.router.owns(`${BROWSER_HELP_PARK_PREFIX}req-1`)).toBe(true);
    h.router.onParkedOutcome(`${BROWSER_HELP_PARK_PREFIX}req-1`, 'delivered');
    h.table.set('main', { requests: [], closed: [{ requestId: 'req-1', state: 'cancelled' }] });
    expect(h.sent.map((s) => s.payload.resolution)).toEqual(['cancelled']);
    expect(h.sent[0].opts.deviceIds).toEqual(['phone-1']);
  });

  it('a held push forgotten because its desktop left is pushed once when a desktop lists it again', () => {
    const h = harness({ present: true });
    h.table.set('main', { requests: [row()] });
    h.router.forgetParked();
    h.table.onClientClose('main');
    h.state.present = false;
    h.state.owner = 'main-2';
    h.table.set('main-2', { requests: [row()] });
    h.table.set('main-2', { requests: [row()] });
    expect(h.sent.map((s) => s.payload.browserHelpId)).toEqual(['req-1']);
  });
});
