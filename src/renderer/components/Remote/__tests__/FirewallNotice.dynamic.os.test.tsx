// @vitest-environment jsdom
// The firewall check runs a PowerShell process in the daemon, so it must run
// only on a deliberate event: when its surface turns it on, and when the
// listener's port (or state) changes — never because the surface re-rendered
// on its poll. A Fix asks once, and the check after it is what is shown.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirewallNoticeView, useFirewall } from '../FirewallNotice';
import { inapplicableStatus, type FirewallActionResult, type InboundStatusView } from '../../../../shared/netFirewall';

const t = (key: string): string => key;

function status(over: Partial<InboundStatusView> = {}): InboundStatusView {
  return {
    ...inapplicableStatus('a2a', 'win32', 'C:\\w\\app-1.0.0\\wmux.exe', 1),
    applicable: true,
    port: 45660,
    verdict: 'not-covered',
    ruleIds: { allow: 'a', pubblock: 'b' },
    elevation: 'consent',
    ...over,
  };
}

function Harness({ enabled, checkKey, tick }: { enabled: boolean; checkKey: string; tick: number }) {
  const c = useFirewall('a2a', { enabled, checkKey });
  return <div data-tick={tick}><FirewallNoticeView c={c} listener="a2a" primary t={t} /></div>;
}

let container: HTMLDivElement;
let root: Root;
let api: { status: ReturnType<typeof vi.fn>; fix: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; listenProblem: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = {
    status: vi.fn(async () => status()),
    fix: vi.fn(async (): Promise<FirewallActionResult> => ({ outcome: { kind: 'ok' }, status: status({ verdict: 'covered' }) })),
    remove: vi.fn(),
    listenProblem: vi.fn(),
    open: vi.fn(),
  };
  vi.stubGlobal('electronAPI', { netFirewall: api });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useFirewall', () => {
  it('checks once when enabled, not on re-renders, again when the port changes', async () => {
    await act(async () => root.render(<Harness enabled checkKey="45660" tick={0} />));
    await settle();
    expect(api.status).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 3; i++) {
      await act(async () => root.render(<Harness enabled checkKey="45660" tick={i} />));
    }
    await settle();
    expect(api.status).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Harness enabled checkKey="45661" tick={4} />));
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('nothing to check while disabled', async () => {
    await act(async () => root.render(<Harness enabled={false} checkKey="45660" tick={0} />));
    await settle();
    expect(api.status).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('a Fix asks once and shows what the check after it says', async () => {
    await act(async () => root.render(<Harness enabled checkKey="45660" tick={0} />));
    await settle();
    const fix = container.querySelector<HTMLButtonElement>('[data-firewall-fix]');
    expect(fix).not.toBeNull();
    await act(async () => { fix?.click(); });
    await settle();
    expect(api.fix).toHaveBeenCalledTimes(1);
    expect(api.fix).toHaveBeenCalledWith('a2a');
    expect(container.querySelector('[data-firewall-line]')?.getAttribute('data-verdict')).toBe('covered');
    expect(container.textContent).toContain('net.fw.nowRetry');
    expect(container.querySelector('[data-firewall-fix]')).toBeNull();
  });

  it('a refusal because things changed checks again', async () => {
    api.fix.mockResolvedValueOnce({ outcome: { kind: 'refused', refusal: 'changed' }, status: null });
    await act(async () => root.render(<Harness enabled checkKey="45660" tick={0} />));
    await settle();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-firewall-fix]')?.click(); });
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('a failed read says it could not read the firewall, with Check', async () => {
    api.status.mockRejectedValueOnce(new Error('daemon gone'));
    await act(async () => root.render(<Harness enabled checkKey="45660" tick={0} />));
    await settle();
    expect(container.textContent).toContain('net.fw.unknown');
    expect(container.querySelector('[data-firewall-check]')).not.toBeNull();
  });
});
