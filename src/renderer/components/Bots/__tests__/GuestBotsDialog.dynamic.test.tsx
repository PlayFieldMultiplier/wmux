// @vitest-environment jsdom
// The guest bots dialog: the owner's switch, Add guest (name and one
// conversation) showing the token once, and Revoke.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestBotGates, GuestBotView, GuestScope } from '../../../../shared/guestBots';
import { en } from '../../../i18n/locales/en';
import GuestBotsDialog, { guestGateNotes } from '../GuestBotsDialog';
import { GuestRevocations, type GuestBotPort } from '../guestBots';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

const DM: GuestScope = { workspaceId: 'ws-1', threadId: 'dm:bot-0000aaaa' };
const GROUP: GuestScope = { workspaceId: 'ws-1', threadId: 'group:grp-0000abcd' };
const conversations = [{ scope: DM, label: 'Dev' }, { scope: GROUP, label: 'Team' }];
const GATES: GuestBotGates = { enabled: true, serverRunning: true, transcript: true, input: true, secureTransport: true };
const ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'wmuxguest~' + ID + '~' + 'S'.repeat(43);

function fakePort(start: GuestBotView[] = [], gates: GuestBotGates = GATES, guestWorkspaces: string[] = ['ws-1']) {
  let guests = [...start];
  const flagged = new Set(guestWorkspaces);
  let g = { ...gates };
  const port = {
    available: true,
    list: vi.fn(async () => ({ ok: true as const, guests, gates: g, workspaces: { readable: true, workspaceIds: [...flagged] } })),
    create: vi.fn(async (req: { name: string; scope: GuestScope }) => {
      const guest: GuestBotView = { v: 1, guestId: ID, name: req.name, scope: req.scope, createdAt: '2026-10-19T00:00:00.000Z' };
      guests = [...guests, guest];
      return { ok: true as const, guest, token: TOKEN };
    }),
    revoke: vi.fn(async (id: string) => {
      guests = guests.map((x) => (x.guestId === id ? { ...x, revokedAt: '2026-10-19T01:00:00.000Z' } : x));
      return { ok: true as const };
    }),
    setEnabled: vi.fn(async (on: boolean) => { g = { ...g, enabled: on }; return { ok: true as const }; }),
    markWorkspace: vi.fn(async (ws: string) => { flagged.add(ws); return { ok: true as const }; }),
  };
  return port satisfies GuestBotPort;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  revocations = new GuestRevocations();
  useStore.getState().clearToasts();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = <E extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as E | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function type(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: Element | null): Promise<void> {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

let revocations = new GuestRevocations();
async function open(port: ReturnType<typeof fakePort>) {
  act(() => root.render(<GuestBotsDialog t={t} conversations={conversations} onClose={() => undefined} port={port} revocations={revocations} />));
  await flush();
}

describe('GuestBotsDialog — guest workspaces', () => {
  it('a conversation outside a guest workspace offers to make it one, with the warning; Add waits for it', async () => {
    const port = fakePort([], GATES, []);
    await open(port);
    expect(q('[data-guest-workspaces]')?.textContent).toBe(en['botsPage.guest.workspacesNone']);
    type(q<HTMLInputElement>('[data-testid="guest-name"]')!, 'Grok');
    expect(q<HTMLButtonElement>('[data-testid="guest-add"]')!.disabled).toBe(true);
    expect(q('[data-guest-mark-warning]')?.textContent).toBe(en['botsPage.guest.markWarning']);
    expect(q('[data-guest-mark-warning]')?.textContent).toContain('Anything in this workspace can be shared with its guests.');
    await click(q('[data-testid="guest-mark"]'));
    expect(port.markWorkspace).toHaveBeenCalledWith('ws-1');
    expect(q('[data-guest-mark-offer]')).toBeNull();
    expect(q('[data-guest-workspaces]')?.textContent).toContain('ws-1');
    expect(q<HTMLButtonElement>('[data-testid="guest-add"]')!.disabled).toBe(false);
  });

  it('a refused flag says why, naming the bots', async () => {
    const port = fakePort([], GATES, []);
    port.markWorkspace.mockImplementationOnce(async () => ({ ok: false, code: 'refused', refusal: 'bots', botIds: ['bot-0000aaaa'] }) as never);
    act(() => root.render(<GuestBotsDialog t={t} conversations={conversations} onClose={() => undefined} port={port} revocations={revocations} botName={(id) => (id === 'bot-0000aaaa' ? 'Dev' : id)} />));
    await flush();
    await click(q('[data-testid="guest-mark"]'));
    expect(q('[data-guest-error]')?.textContent).toContain('Dev');
    expect(q('[data-guest-mark-offer]')).not.toBeNull();
  });

  it('a guest whose workspace is not a guest one shows as needing revoke; an unreadable list says so', async () => {
    const port = fakePort([{ v: 1, guestId: ID, name: 'Grok', scope: { workspaceId: 'ws-old', threadId: 'general' }, createdAt: '2026-10-19T00:00:00.000Z' }]);
    await open(port);
    expect(q(`[data-guest-row="${ID}"]`)?.getAttribute('data-guest-needs-revoke')).toBe('true');
    expect(q(`[data-guest-row="${ID}"]`)?.textContent).toContain(en['botsPage.guest.needsRevoke']);
    act(() => root.unmount());
    root = createRoot(host);
    const broken = fakePort();
    broken.list.mockImplementation(async () => ({ ok: true as const, guests: [], gates: GATES, workspaces: { readable: false, workspaceIds: [] } }));
    await open(broken);
    expect(q('[data-guest-workspaces-unreadable]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    const restored = fakePort();
    restored.list.mockImplementation(async () => ({ ok: true as const, guests: [], gates: GATES, workspaces: { readable: true, workspaceIds: ['ws-1'], restored: true as const } }));
    await open(restored);
    expect(q('[data-guest-workspaces-restored]')?.textContent).toBe(en['botsPage.guest.workspacesRestored']);
  });
});

describe('GuestBotsDialog', () => {
  it('adds a guest for the picked conversation and shows its token once', async () => {
    const port = fakePort();
    await open(port);
    expect(q('[data-guest-empty]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="guest-add"]')!.disabled).toBe(true);
    type(q<HTMLInputElement>('[data-testid="guest-name"]')!, '  Grok  ');
    const sel = q<HTMLSelectElement>('[data-testid="guest-conversation"]')!;
    act(() => { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(q('[data-testid="guest-add"]'));
    expect(port.create).toHaveBeenCalledWith({ name: 'Grok', scope: GROUP });
    expect(q<HTMLInputElement>('[data-testid="guest-token"]')!.value).toBe(TOKEN);
    expect(q(`[data-guest-row="${ID}"]`)?.textContent).toContain('Team');
    // The name field is cleared for the next guest.
    expect(q<HTMLInputElement>('[data-testid="guest-name"]')!.value).toBe('');
  });

  it('the token is gone once the dialog is reopened', async () => {
    const port = fakePort();
    await open(port);
    type(q<HTMLInputElement>('[data-testid="guest-name"]')!, 'Grok');
    await click(q('[data-testid="guest-add"]'));
    expect(q('[data-testid="guest-token"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await open(port);
    expect(q('[data-testid="guest-token"]')).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('revokes a guest; a revoked guest has no Revoke button', async () => {
    const port = fakePort([{ v: 1, guestId: ID, name: 'Grok', scope: DM, createdAt: '2026-10-19T00:00:00.000Z' }]);
    await open(port);
    await click(q(`[data-testid="guest-revoke-${ID}"]`));
    expect(port.revoke).toHaveBeenCalledWith(ID);
    expect(q(`[data-guest-row="${ID}"]`)?.getAttribute('data-guest-revoked')).toBe('true');
    expect(q(`[data-testid="guest-revoke-${ID}"]`)).toBeNull();
  });

  it('a revoke in flight shows Revoking… and sends once; a failure shows in the open dialog, not as a toast', async () => {
    const port = fakePort([{ v: 1, guestId: ID, name: 'Grok', scope: DM, createdAt: '2026-10-19T00:00:00.000Z' }]);
    let answer: (r: { ok: false; code: 'persist-failed' }) => void = () => undefined;
    port.revoke.mockImplementationOnce(() => new Promise((res) => { answer = res; }) as never);
    await open(port);
    await click(q(`[data-testid="guest-revoke-${ID}"]`));
    const btn = q<HTMLButtonElement>(`[data-testid="guest-revoke-${ID}"]`)!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe(en['botsPage.guest.revoking']);
    await click(btn);
    expect(port.revoke).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ ok: false, code: 'persist-failed' }); });
    await flush();
    expect(q('[data-guest-error]')?.textContent).toBe(en['botsPage.guest.error.persistFailed']);
    expect(q<HTMLButtonElement>(`[data-testid="guest-revoke-${ID}"]`)!.disabled).toBe(false);
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('a revoke that fails after the dialog closed becomes a persistent error toast', async () => {
    const port = fakePort([{ v: 1, guestId: ID, name: 'Grok', scope: DM, createdAt: '2026-10-19T00:00:00.000Z' }]);
    let answer: (r: { ok: false; code: 'unavailable' }) => void = () => undefined;
    port.revoke.mockImplementationOnce(() => new Promise((res) => { answer = res; }) as never);
    await open(port);
    await click(q(`[data-testid="guest-revoke-${ID}"]`));
    act(() => root.unmount());
    root = createRoot(host);
    expect(revocations.isPending(ID)).toBe(true);
    await act(async () => { answer({ ok: false, code: 'unavailable' }); });
    await flush();
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ level: 'error', persist: true });
    expect(toasts[0].message).toContain('Grok');
    expect(toasts[0].message).toContain(en['botsPage.guest.error.unavailable']);
    // Reopened while one is in flight, the dialog shows it as Revoking….
    port.revoke.mockImplementationOnce(() => new Promise(() => undefined) as never);
    await open(port);
    await click(q(`[data-testid="guest-revoke-${ID}"]`));
    act(() => root.unmount());
    root = createRoot(host);
    await open(port);
    expect(q<HTMLButtonElement>(`[data-testid="guest-revoke-${ID}"]`)!.disabled).toBe(true);
  });

  it('shows a refusal from the daemon', async () => {
    const port = fakePort();
    port.create.mockResolvedValueOnce({ ok: false, code: 'too-many' } as never);
    await open(port);
    type(q<HTMLInputElement>('[data-testid="guest-name"]')!, 'Grok');
    await click(q('[data-testid="guest-add"]'));
    expect(q('[data-guest-error]')?.textContent).toBe(t('botsPage.guest.error.tooMany'));
    expect(q('[data-testid="guest-token"]')).toBeNull();
  });

  it('the switch turns the feature on and off', async () => {
    const port = fakePort([], { ...GATES, enabled: false });
    await open(port);
    await click(q('[data-testid="guest-enable"]'));
    expect(port.setEnabled).toHaveBeenCalledWith(true);
  });

  it('says, before a guest is added, that it reads this conversation from now on', async () => {
    await open(fakePort());
    expect(q('[data-guest-read-notice]')?.textContent).toBe(en['botsPage.guest.readNotice']);
  });

  it('a gate note names the setting to turn on as the web panel names it, never a flag', async () => {
    await open(fakePort([], { ...GATES, transcript: false }));
    const note = q('[data-guest-gate="botsPage.guest.gate.transcript"]')?.textContent ?? '';
    expect(note).toContain(`"${en['web.allowTranscript']}"`);
    expect(note).not.toMatch(/--allow|transcript/);
    act(() => root.unmount());
    root = createRoot(host);
    await open(fakePort([], { ...GATES, secureTransport: false, input: false }));
    expect(q('[data-guest-gate="botsPage.guest.gate.input"]')?.textContent).toContain(`"${en['web.allowInput']}"`);
    const transport = q('[data-guest-gate="botsPage.guest.gate.transport"]')?.textContent ?? '';
    expect(transport).toContain('"Serve over HTTPS (needs Tailscale)"');
    expect(transport).toContain(`"${en['web.expose']}"`);
  });

  it('names the remote-access gates still in the way', () => {
    expect(guestGateNotes(GATES)).toEqual([]);
    expect(guestGateNotes({ ...GATES, serverRunning: false, secureTransport: false })).toEqual(['botsPage.guest.gate.server']);
    expect(guestGateNotes({ ...GATES, secureTransport: false, transcript: false })).toEqual(['botsPage.guest.gate.transport', 'botsPage.guest.gate.transcript']);
    expect(guestGateNotes({ ...GATES, input: false })).toEqual(['botsPage.guest.gate.input']);
  });
});
