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

describe('useFirewall: re-checks and what each answer leaves on screen', () => {
  async function mount() {
    await act(async () => root.render(<Harness enabled checkKey="45660" tick={0} />));
    await settle();
  }
  const click = async (sel: string) => {
    await act(async () => { container.querySelector<HTMLButtonElement>(sel)?.click(); });
    await settle();
  };

  it('the check on opening may share a running probe; Check firewall asks for one that starts now', async () => {
    api.status.mockResolvedValueOnce(status({ verdict: 'unknown' }));
    await mount();
    expect(api.status).toHaveBeenLastCalledWith('a2a', false);
    await click('[data-firewall-check]');
    expect(api.status).toHaveBeenLastCalledWith('a2a', true);
  });

  it('after Open network settings, the window coming back checks once, fresh', async () => {
    api.status.mockResolvedValueOnce(status({ verdict: 'public-network', publicNetworks: ['Wi-Fi'] }));
    await mount();
    expect(api.status).toHaveBeenCalledTimes(1);
    // Focus without an Open… first: no check.
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(api.status).toHaveBeenCalledTimes(1);
    await click('[data-firewall-open="network"]');
    expect(api.open).toHaveBeenCalledWith('network', 'ms-settings:network-status');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.status).toHaveBeenLastCalledWith('a2a', true);
    // Once per Open…
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it('Open network settings asks main for the page of the Public networks\' adapter kind', async () => {
    const cases: Array<[Partial<InboundStatusView>, unknown[]]> = [
      [{ verdict: 'public-network', publicNetworks: ['Wi-Fi'], publicMedium: 'wifi' }, ['network', 'ms-settings:network-wifi']],
      [{ verdict: 'public-network', publicNetworks: ['Ethernet'], publicMedium: 'ethernet' }, ['network', 'ms-settings:network-ethernet']],
      // The Public half of a mixed PC, on its own row.
      [{ verdict: 'covered', okNetworks: ['Tailscale'], publicNetworks: ['Ethernet'], publicMedium: 'ethernet' }, ['network', 'ms-settings:network-ethernet']],
      // Not Windows: no page, main opens its own.
      [{ verdict: 'public-network', platform: 'darwin', ruleIds: null }, ['network']],
    ];
    for (const [over, args] of cases) {
      api.open.mockClear();
      api.status.mockResolvedValueOnce(status(over));
      await act(async () => root.render(<Harness enabled checkKey={JSON.stringify(over)} tick={0} />));
      await settle();
      await click('[data-firewall-open="network"]');
      expect(api.open.mock.calls, JSON.stringify(over)).toEqual([args]);
    }
  });

  it('an action that ends while a check runs leaves no button stuck on Checking…', async () => {
    await mount();
    let finishCheck: (s: InboundStatusView) => void = () => undefined;
    let finishFix: (r: FirewallActionResult) => void = () => undefined;
    api.fix.mockImplementationOnce(() => new Promise((r) => { finishFix = r; }));
    await click('[data-firewall-fix]');
    // The listener restarts during the prompt: its check starts and is still running when the Fix ends.
    api.status.mockImplementationOnce(() => new Promise((r) => { finishCheck = r; }));
    await act(async () => root.render(<Harness enabled checkKey="45661" tick={1} />));
    await settle();
    await act(async () => { finishFix({ outcome: { kind: 'cancelled' }, status: status() }); });
    await settle();
    const fix = container.querySelector<HTMLButtonElement>('[data-firewall-fix]');
    expect(fix?.getAttribute('aria-disabled')).toBeNull();
    expect(container.textContent).toContain('net.fw.cancelled');
    // The old check's answer arrives late and is dropped.
    await act(async () => { finishCheck(status({ verdict: 'covered' })); });
    await settle();
    expect(container.querySelector('[data-firewall-fix]')).not.toBeNull();
  });

  it('a click refused as busy says another change is running', async () => {
    api.fix.mockResolvedValueOnce({ outcome: { kind: 'refused', refusal: 'busy' }, status: null });
    await mount();
    await click('[data-firewall-fix]');
    expect(container.textContent).toContain('net.fw.busy');
    expect(container.querySelector('[data-firewall-fix]')).not.toBeNull();
  });

  it('a Fix whose call fails, or whose check after it fails, shows the could-not-read row and Check', async () => {
    api.fix.mockRejectedValueOnce(new Error('daemon gone'));
    await mount();
    await click('[data-firewall-fix]');
    expect(container.textContent).toContain('net.fw.unknown');
    expect(container.textContent).toContain('net.fw.failed');
    expect(container.querySelector('[data-firewall-check]')).not.toBeNull();

    api.fix.mockResolvedValueOnce({ outcome: { kind: 'ok' }, status: null });
    await click('[data-firewall-check]');
    await click('[data-firewall-fix]');
    expect(container.textContent).toContain('net.fw.okUnchecked');
    expect(container.querySelector('[data-firewall-check]')).not.toBeNull();
  });

  it('after a Fix replaces its button, focus lands on what replaced it', async () => {
    await mount();
    const fix = container.querySelector<HTMLButtonElement>('[data-firewall-fix]');
    fix?.focus();
    expect(document.activeElement).toBe(fix);
    await act(async () => { fix?.click(); });
    await settle();
    const line = container.querySelector('[data-firewall-line]');
    expect(line).not.toBeNull();
    expect(document.activeElement).toBe(line);
  });
});
