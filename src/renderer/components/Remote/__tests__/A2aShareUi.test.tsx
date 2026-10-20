// @vitest-environment jsdom
//
// "Share this pane with <PC>…": when a PC can take a share, and the dialog
// view (what that PC sees, the directions, the one primary, the reasons it
// cannot). Pure views and helpers, rendered with a stub `t`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ReactElement } from 'react';
import { A2A_FEATURE_LINK_OFFER, type A2aLinkOfferRecordV1, type A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';
import { A2aShareDialogView, shareBlock, type A2aShareDialogViewProps } from '../A2aShareDialog';
import { A2aShareRow } from '../A2aLinksPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const roots: Array<{ root: Root; el: HTMLElement }> = [];
function render(ui: ReactElement): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  roots.push({ root, el });
  return document.body;
}
afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
});

const A = '11111111-1111-4111-8111-111111111111';
const PANE = { workspaceId: 'ws', paneId: 'p1' };
const host = (features?: string[]): A2aRemoteHostStatus => ({ hostId: A, name: 'LAPTOP', role: 'server', state: 'connected', pending: 0, ...(features ? { features } : {}) });
const share = (o: Partial<A2aLinkOfferRecordV1> = {}): A2aLinkOfferRecordV1 => ({
  v: 1, offerId: '33333333-3333-4333-8333-333333333333', side: 'out', hostId: A,
  end: { kind: 'pane', workspaceId: 'ws', workspaceName: 'API', paneId: 'p1', label: 'w1-1' }, allow: { outbound: true, inbound: true },
  state: 'open', createdAt: '', updatedAt: '', expiresAt: '', ...o,
});

describe('shareBlock', () => {
  it('can share with a connected PC that takes offers', () => {
    expect(shareBlock(A, PANE, { hosts: [host([A2A_FEATURE_LINK_OFFER])], links: [], offers: [] })).toBeNull();
  });

  it('says why not: an older wmux, not connected since start, already linked, already shared', () => {
    expect(shareBlock(A, PANE, { hosts: [host([])], links: [], offers: [] })).toBe('unsupported');
    expect(shareBlock(A, PANE, { hosts: [host()], links: [], offers: [] })).toBe('not-connected');
    expect(shareBlock(A, PANE, { hosts: [], links: [], offers: [] })).toBe('not-connected');
    const link = { linkId: 'l', state: 'active', remote: { hostId: A }, local: { kind: 'pane', workspaceId: 'ws', paneId: 'p1' } } as unknown as A2aLinkRecordV1;
    expect(shareBlock(A, PANE, { hosts: [host([A2A_FEATURE_LINK_OFFER])], links: [link], offers: [] })).toBe('linked');
    expect(shareBlock(A, PANE, { hosts: [host([A2A_FEATURE_LINK_OFFER])], links: [], offers: [share()] })).toBe('shared');
    expect(shareBlock(A, PANE, { hosts: [host([A2A_FEATURE_LINK_OFFER])], links: [], offers: [share({ state: 'declined', endedReason: 'declined' })] })).toBeNull();
  });
});

function props(over: Partial<A2aShareDialogViewProps> = {}): A2aShareDialogViewProps {
  return {
    paneName: 'API / w1-1', agent: 'claude', cwd: '/srv/api', repo: 'github.com/acme/api',
    peers: [{ hostId: A, name: 'LAPTOP' }], hostId: A, onPickHost: () => undefined,
    block: null, send: true, receive: true, onSend: () => undefined, onReceive: () => undefined,
    busy: false, outcome: null, onShare: () => undefined, onWithdraw: () => undefined, onClose: () => undefined, t,
    ...over,
  };
}

describe('A2aShareDialogView', () => {
  it('names what the other PC will see, ticks both directions, and shares with one primary', () => {
    const onShare = vi.fn();
    const body = render(createElement(A2aShareDialogView, props({ onShare })));
    expect(body.textContent).toContain('a2aShare.title(API / w1-1,LAPTOP)');
    expect(body.querySelector('[data-testid="a2a-share-shown"]')?.textContent).toContain('claude · github.com/acme/api · /srv/api');
    expect([...body.querySelectorAll('[role="checkbox"]')].map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true']);
    expect(body.querySelector('[role="radiogroup"]')).toBeNull();
    expect(body.querySelectorAll('.ui-btn-primary')).toHaveLength(1);
    act(() => (body.querySelector('[data-testid="a2a-share-submit"]') as HTMLButtonElement).click());
    expect(onShare).toHaveBeenCalledOnce();
  });

  it('cannot share with no direction, or while a reason blocks it (a muted line, no colour)', () => {
    let body = render(createElement(A2aShareDialogView, props({ send: false, receive: false })));
    expect((body.querySelector('[data-testid="a2a-share-submit"]') as HTMLButtonElement).disabled).toBe(true);
    for (const el of roots.splice(0)) { act(() => el.root.unmount()); el.el.remove(); }
    body = render(createElement(A2aShareDialogView, props({ block: 'unsupported' })));
    const line = body.querySelector('[data-testid="a2a-share-block"]')!;
    expect(line.textContent).toBe('a2aShare.block.unsupported(LAPTOP)');
    expect(line.getAttribute('data-tone')).toBeNull();
    expect((body.querySelector('[data-testid="a2a-share-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an open share offers Withdraw; several PCs get a picker', () => {
    const onWithdraw = vi.fn();
    const body = render(createElement(A2aShareDialogView, props({
      block: 'shared', onWithdraw, peers: [{ hostId: A, name: 'LAPTOP' }, { hostId: 'b', name: 'DESK' }],
    })));
    expect(body.querySelectorAll('[role="radio"]')).toHaveLength(2);
    act(() => (body.querySelector('[data-testid="a2a-share-withdraw"]') as HTMLButtonElement).click());
    expect(onWithdraw).toHaveBeenCalledOnce();
  });

  it('after sharing it says what happens next and offers no second share', () => {
    const body = render(createElement(A2aShareDialogView, props({ outcome: { ok: true } })));
    expect(body.querySelector('[data-testid="a2a-share-outcome"]')?.textContent).toBe('a2aShare.shared(LAPTOP)');
    expect(body.querySelector('[data-testid="a2a-share-submit"]')).toBeNull();
  });
});

describe('A2aShareRow', () => {
  it('is a neutral nested row with Withdraw', () => {
    const onWithdraw = vi.fn();
    const body = render(createElement('ul', null, createElement(A2aShareRow, { offer: share(), pcName: 'LAPTOP', busy: false, onWithdraw, t })));
    const row = body.querySelector('[data-testid="a2a-share-row"]')!;
    expect(row.textContent).toContain('API / w1-1 → LAPTOP · a2aShare.waiting(LAPTOP)');
    expect(row.getAttribute('data-tone')).toBeNull();
    act(() => (row.querySelector('[data-testid="a2a-share-row-withdraw"]') as HTMLButtonElement).click());
    expect(onWithdraw).toHaveBeenCalledOnce();
  });
});
