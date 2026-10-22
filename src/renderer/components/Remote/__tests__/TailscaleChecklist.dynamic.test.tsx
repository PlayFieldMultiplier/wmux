// @vitest-environment jsdom
// The Remote page's Tailscale checklist: four checks from one read-only
// status read, the first failure with exactly one button, and nothing opened
// or run until that button is clicked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TailscaleChecklist, { TAILSCALE_RECHECK_AFTER_OPEN_MS } from '../TailscaleChecklist';
import { blockingFailure, fixForProblem, isTailnetHost, tailnetPrecheck, tailnetTargetOf } from '../tailnetCheck';
import type { TailscaleChecklist as Checklist, TailscaleCheckItem } from '../../../../shared/web';

let container: HTMLDivElement;
let root: Root;
let web: { tailscaleCheck: ReturnType<typeof vi.fn>; tailscaleOpen: ReturnType<typeof vi.fn> };

const IDS = ['installed', 'signed-in', 'self', 'peer'] as const;
function list(failAt: number | null, reason?: TailscaleCheckItem['reason'], fix?: TailscaleCheckItem['fix']): Checklist {
  const items = IDS.map((id, i): TailscaleCheckItem => (
    failAt === null || i < failAt ? { id, state: 'pass' }
      : i === failAt ? { id, state: 'fail', ...(reason ? { reason } : {}), ...(fix ? { fix } : {}) }
        : { id, state: 'unchecked' }
  ));
  return { items, ok: failAt === null, peersOnline: 2 };
}

async function render(answer: Checklist) {
  web = {
    tailscaleCheck: vi.fn(async () => answer),
    tailscaleOpen: vi.fn(async () => ({ ok: true, opened: 'app' })),
  };
  vi.stubGlobal('electronAPI', { web });
  await act(async () => root.render(<TailscaleChecklist />));
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const row = (id: string) => container.querySelector<HTMLElement>(`[data-ts-check="${id}"]`)!;
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-tailscale-fix]')];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Tailscale checklist', () => {
  it('all four passing: one line of ticks, no buttons, the count of online devices', async () => {
    await render(list(null));
    expect(container.querySelector('[data-tailscale-checklist]')?.getAttribute('data-ok')).toBe('true');
    for (const id of IDS) expect(row(id).dataset.state).toBe('pass');
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain('2 other devices online');
    expect(web.tailscaleCheck).toHaveBeenCalledTimes(1);
    expect(web.tailscaleOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['installed', 0, 'not-installed', 'download', 'download'],
    ['signed-in', 1, 'signed-out', 'sign-in', 'app'],
    ['self', 2, 'stopped', 'open-app', 'app'],
  ] as const)('%s failing: its reason and exactly one button, which opens only on click', async (id, at, reason, fix, target) => {
    await render(list(at, reason, fix));
    expect(row(id).dataset.state).toBe('fail');
    expect(row(id).querySelector('[data-ts-reason]')?.getAttribute('data-ts-reason')).toBe(reason);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].dataset.tailscaleFix).toBe(fix);
    for (const later of IDS.slice(at + 1)) expect(row(later).dataset.state).toBe('unchecked');
    // Nothing is opened (let alone run) by showing the checklist.
    expect(web.tailscaleOpen).not.toHaveBeenCalled();
    await act(async () => { buttons()[0].click(); });
    expect(web.tailscaleOpen).toHaveBeenCalledTimes(1);
    expect(web.tailscaleOpen).toHaveBeenCalledWith(target);
    // Opened: checked again once Tailscale had a moment to come up.
    await act(async () => { vi.advanceTimersByTime(TAILSCALE_RECHECK_AFTER_OPEN_MS); });
    expect(web.tailscaleCheck).toHaveBeenCalledTimes(2);
  });

  it('peer failing: its button only unfolds how to sign the other device in, and opens nothing', async () => {
    await render(list(3, 'no-peer', 'peer-help'));
    expect(row('peer').dataset.state).toBe('fail');
    expect(buttons()).toHaveLength(1);
    await act(async () => { buttons()[0].click(); });
    expect(container.querySelector('[data-tailscale-help]')?.textContent).toMatch(/same account/);
    expect(web.tailscaleOpen).not.toHaveBeenCalled();
  });
});

describe('which connections a failed check holds back', () => {
  it('only a piece whose every address is on the tailnet', () => {
    expect(isTailnetHost('desk.tail1.ts.net.')).toBe(true);
    expect(isTailnetHost('100.101.12.4')).toBe(true);
    expect(isTailnetHost('192.168.0.12')).toBe(false);
    const fp = Array.from({ length: 32 }, () => 'A7').join(':');
    expect(tailnetTargetOf(`wmux-a2a://desk.tail1.ts.net:45660/K7M2QX9P#sha256=${fp}&alt=100.101.12.4`)).toBe('desk.tail1.ts.net');
    // A LAN address among them may work with Tailscale off: not held back.
    expect(tailnetTargetOf(`wmux-a2a://desk.tail1.ts.net:45660/K7M2QX9P#sha256=${fp}&alt=192.168.0.12`)).toBeNull();
    expect(tailnetTargetOf(`wmux-a2a://desk.corp.example:45660/K7M2QX9P#sha256=${fp}`)).toBeNull();
    expect(tailnetTargetOf('https://office.ts.net/pair#wmux-desktop-code=ABCD2345')).toBe('office.ts.net');
    expect(tailnetTargetOf('https://192.168.0.12:7681/pair#wmux-desktop-code=ABCD2345')).toBeNull();
  });

  it('an unreadable status never blocks; a fixable failure does', () => {
    expect(blockingFailure(list(1, 'unreadable', 'open-app'))).toBeNull();
    expect(blockingFailure(list(1, 'not-running', 'open-app'))).toMatchObject({ reason: 'not-running' });
    expect(blockingFailure(list(null))).toBeNull();
    expect(blockingFailure(null)).toBeNull();
  });

  it('the pre-connect check every pairing form runs: LAN hosts are never checked, a tailnet host with Tailscale off is held', async () => {
    const check = vi.fn(async () => list(1, 'not-running', 'open-app'));
    vi.stubGlobal('electronAPI', { web: { tailscaleCheck: check } });
    expect(await tailnetPrecheck('192.168.0.12')).toBeNull();
    expect(await tailnetPrecheck(null)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    const held = await tailnetPrecheck('office.tail1.ts.net');
    expect(check).toHaveBeenCalledWith('office.tail1.ts.net');
    expect(held).toMatchObject({ fix: 'open-app' });
    expect(held?.text).toMatch(/Tailscale is off/);
  });

  it('maps a share-start problem to its one button', () => {
    expect(fixForProblem('not-installed')).toBe('download');
    expect(fixForProblem('not-running')).toBe('open-app');
    expect(fixForProblem('not-logged-in')).toBe('sign-in');
    expect(fixForProblem('port-taken')).toBeNull();
  });
});
