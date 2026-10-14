// @vitest-environment jsdom
// "Add PC over SSH": pick a Host from ~/.ssh/config or type user@host, press
// Install, follow the phases main reports, and land on "added" or on a
// failure that says what to do — an ssh prompt points at a terminal.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddSshPcDialog, { isTypedSshTarget, sshFailureKey } from '../AddSshPcDialog';
import type { SshAddProgress, SshAddResult } from '../../../../shared/remoteHosts';

let container: HTMLDivElement;
let root: Root;
let remote: Record<string, ReturnType<typeof vi.fn>>;
let progress: ((e: SshAddProgress) => void) | null;
let resolveAdd: (r: SshAddResult) => void;

const q = <E extends Element = HTMLElement>(id: string) => document.querySelector<E>(`[data-testid="${id}"]`);
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  progress = null;
  remote = {
    sshCandidates: vi.fn(async () => ['office', 'vps']),
    sshAdd: vi.fn(() => new Promise<SshAddResult>((r) => { resolveAdd = r; })),
    sshCancel: vi.fn(async () => true),
    onSshProgress: vi.fn((cb: (e: SshAddProgress) => void) => { progress = cb; return () => { progress = null; }; }),
  };
  vi.stubGlobal('electronAPI', { remote });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AddSshPcDialog', () => {
  it('lists config hosts; Install stays off until one is picked; progress follows its own request only', async () => {
    const onAdded = vi.fn();
    await act(async () => root.render(<AddSshPcDialog onClose={vi.fn()} onAdded={onAdded} />));
    await flush();
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(['office', 'vps']);
    expect(q<HTMLButtonElement>('remote-ssh-install')?.disabled).toBe(true);
    await act(async () => options[1].click());
    expect(q<HTMLButtonElement>('remote-ssh-install')?.disabled).toBe(false);
    await act(async () => q<HTMLButtonElement>('remote-ssh-install')?.click());
    expect(remote.sshAdd).toHaveBeenCalledWith('vps', expect.any(String));
    const requestId = remote.sshAdd.mock.calls[0][1] as string;
    await act(async () => progress?.({ requestId: 'someone-else', phase: 'pair' }));
    expect(document.querySelector('[data-state="active"]')?.getAttribute('data-phase')).toBe('connect');
    await act(async () => progress?.({ requestId, phase: 'install' }));
    expect(document.querySelector('[data-state="active"]')?.getAttribute('data-phase')).toBe('install');
    await act(async () => resolveAdd({ ok: true, upgradePending: false, host: { id: 'h1', label: 'vps', origin: 'wmux-ssh://h1', addedAt: 1 } }));
    await flush();
    expect(q('remote-ssh-done')).not.toBeNull();
    expect(onAdded).toHaveBeenCalledWith('h1');
  });

  it('a typed target wins over the picked row and an option-shaped one is refused', async () => {
    await act(async () => root.render(<AddSshPcDialog onClose={vi.fn()} />));
    await flush();
    const input = q<HTMLInputElement>('remote-ssh-typed');
    if (!input) throw new Error('no input');
    const setValue = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => setValue('-oProxyCommand=x'));
    expect(q<HTMLButtonElement>('remote-ssh-install')?.disabled).toBe(true);
    await act(async () => setValue('me@box.lan'));
    await act(async () => q<HTMLButtonElement>('remote-ssh-install')?.click());
    expect(remote.sshAdd).toHaveBeenCalledWith('me@box.lan', expect.any(String));
  });

  it('an auth failure shows the ssh command to run once, and retry runs the same target', async () => {
    await act(async () => root.render(<AddSshPcDialog onClose={vi.fn()} />));
    await flush();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    await act(async () => q<HTMLButtonElement>('remote-ssh-install')?.click());
    await act(async () => resolveAdd({ ok: false, kind: 'auth', message: 'Permission denied (publickey).' }));
    await flush();
    expect(q('remote-ssh-failed')).not.toBeNull();
    expect(q('remote-ssh-hint')?.textContent).toBe('ssh office');
    await act(async () => q<HTMLButtonElement>('remote-ssh-retry')?.click());
    expect(remote.sshAdd).toHaveBeenCalledTimes(2);
    expect(remote.sshAdd.mock.calls[1][0]).toBe('office');
  });

  it('nothing connects before Install: a double-click only picks; Cancel aborts the install in flight', async () => {
    await act(async () => root.render(<AddSshPcDialog onClose={vi.fn()} />));
    await flush();
    const first = document.querySelector<HTMLButtonElement>('[role="option"]');
    await act(async () => first?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(remote.sshAdd).not.toHaveBeenCalled();
    await act(async () => first?.click());
    await act(async () => q<HTMLButtonElement>('remote-ssh-install')?.click());
    const requestId = remote.sshAdd.mock.calls[0][1] as string;
    await act(async () => q<HTMLButtonElement>('remote-ssh-cancel')?.click());
    expect(remote.sshCancel).toHaveBeenCalledWith(requestId);
    expect(q('remote-ssh-pick')).not.toBeNull();
    // The cancelled request's late answer changes nothing.
    await act(async () => resolveAdd({ ok: false, kind: 'cancelled', message: 'cancelled' }));
    expect(q('remote-ssh-pick')).not.toBeNull();
  });

  it('maps failure kinds to their sentence', () => {
    expect(sshFailureKey('host-key-unknown')).toBe('remoteSsh.error.runSshOnce');
    expect(sshFailureKey('desktop-installed')).toBe('remoteSsh.error.desktopInstalled');
    expect(sshFailureKey('anything-else')).toBe('remoteSsh.error.failed');
    expect(isTypedSshTarget('a b')).toBe(false);
  });
});
