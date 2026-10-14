// @vitest-environment jsdom
//
// Bots look like members: BotAvatar draws the owner's picture or the name's
// initials on a theme colour fixed by the bot id; Settings › Factory's Add bot takes
// a name and a picture (a preview from main), the profile editor changes or
// removes the picture on Save, and the bot list and chips show the avatar.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { BOT_NAME_MAX, DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import type { FactoryBotAvatarPickResult, FactoryBotCreateRequest } from '../../../../shared/botCreate';
import BotAvatar, { BOT_AVATAR_TONES, botAvatarTone, botInitials } from '../BotAvatar';
import { BotChips } from '../BotChips';
import { RoomCard } from '../RoomCard';
import type { RoomCard as RoomCardData } from '../../../../shared/room';
import { AddBotForm, FactoryTab, avatarPickError } from '../../Settings/FactoryTab';
import type { FactoryBotPort, FactoryBotRow } from '../factoryPorts';

const WS = 'ws-a';
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;
const roleT = (key: string, vars?: Record<string, string | number>) =>
  (key.startsWith('room.role.') ? key.slice('room.role.'.length).replace(/^./, (c) => c.toUpperCase()) : t(key, vars));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
}

function row(id: string, over: Partial<BotProfile> = {}): FactoryBotRow {
  return {
    bot: {
      version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
      budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, ...over,
    },
    status: null,
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('botInitials', () => {
  it('Latin: two words give two letters, one word one', () => {
    expect(botInitials('Ada Lovelace', 'Lead')).toBe('AL');
    expect(botInitials('verifier', 'Verifier')).toBe('V');
    expect(botInitials('release-bot', 'Lead')).toBe('RB');
    expect(botInitials('  grace   hopper  team ', 'Lead')).toBe('GH');
  });

  it('Korean and CJK: the first syllable or character', () => {
    expect(botInitials('검증봇', 'Verifier')).toBe('검');
    expect(botInitials('김 철수', 'Lead')).toBe('김');
    expect(botInitials('测试机器人', 'Lead')).toBe('测');
    expect(botInitials('テスト', 'Lead')).toBe('テ');
  });

  it('a blank name falls back to the role label', () => {
    expect(botInitials('', 'Verifier')).toBe('V');
    expect(botInitials('   ', 'Maintainer')).toBe('M');
    expect(botInitials('', '')).toBe('?');
  });
});

describe('botAvatarTone', () => {
  it('is the same for the same id, one of the tile tokens and never a state colour', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `bot-${i.toString(16).padStart(8, '0')}`);
    for (const id of ids) {
      expect(botAvatarTone(id)).toBe(botAvatarTone(id));
      expect(BOT_AVATAR_TONES).toContain(botAvatarTone(id));
    }
    expect(new Set(ids.map(botAvatarTone)).size).toBeGreaterThan(1);
    for (const state of ['--accent-red', '--accent-yellow', '--attention']) expect(BOT_AVATAR_TONES).not.toContain(state);
  });
});

describe('BotAvatar', () => {
  it('draws the picture when there is one', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000001', name: 'Ada', role: 'lead', avatar: PICTURE }, size: 20, t: roleT }));
    const el = container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el.dataset.botAvatar).toBe('image');
    expect(el.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
    expect(el.style.width).toBe('20px');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws initials (role fallback for a blank name) on the bot\'s tone, and names itself when asked', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000002', name: ' ', role: 'verifier' }, size: 16, t: roleT, alt: 'Verifier' }));
    const el = container.querySelector<HTMLElement>('[data-bot-avatar]')!;
    expect(el.dataset.botAvatar).toBe('initials');
    expect(el.textContent).toBe('V');
    expect(el.dataset.avatarTone).toBe(botAvatarTone('bot-00000002'));
    expect(el.style.background).toBe(`var(${botAvatarTone('bot-00000002')})`);
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Verifier');
  });

  it('never uses something other than a PNG data URL as an image', async () => {
    await render(createElement(BotAvatar, { bot: { id: 'bot-00000003', name: 'Ada', role: 'lead', avatar: 'https://example.com/a.png' }, size: 16, t: roleT }));
    expect(container.querySelector('[data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('initials');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Add bot: name and picture', () => {
  function port(pick: FactoryBotAvatarPickResult) {
    const create = vi.fn(async (_req: FactoryBotCreateRequest) => ({ ok: true as const, bot: row('bot-00000009').bot }));
    const pickAvatar = vi.fn(async () => pick);
    const p: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create, pickAvatar };
    return { p, create, pickAvatar };
  }

  beforeEach(() => {
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
  });

  it('sends the trimmed name and the picked picture; the preview shows it until removed', async () => {
    const { p, create, pickAvatar } = port({ ok: true, avatar: PICTURE });
    const onDone = vi.fn();
    await render(createElement(AddBotForm, { port: p, rows: [], t: roleT, onDone, pickFolder: async () => '/src/app' }));
    const name = container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    expect(name.placeholder).toBe('settings.factory.addBotNamePlaceholder');
    expect(name.maxLength).toBe(BOT_NAME_MAX);
    // No name yet: the avatar's initials fall back to the default template's role word.
    expect(container.querySelector('[data-testid="factory-picture-preview"] [data-bot-avatar]')?.textContent).toBe('L');
    await act(async () => typeInto(name, '  Ada Lovelace '));
    expect(container.querySelector('[data-testid="factory-picture-preview"] [data-bot-avatar]')?.textContent).toBe('AL');
    expect(container.querySelector('[data-testid="factory-picture-remove"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(pickAvatar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')?.getAttribute('src')).toBe(PICTURE);
    // Remove, then choose again.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-remove"]')!.click());
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, repoFolder: '/src/app', name: 'Ada Lovelace', avatar: PICTURE });
    expect(onDone).toHaveBeenCalled();
  });

  it('a blank name cannot be added; a cancelled pick sends no picture', async () => {
    const { p, create } = port({ ok: false, code: 'cancelled' });
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined, pickFolder: async () => '/src/app' }));
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, '   '));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(container.querySelector('[data-testid="factory-add-bot-error"]')).toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    expect(submit.disabled).toBe(true);
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'Dev'));
    await act(async () => submit.click());
    expect(create).toHaveBeenCalledWith({ workspaceId: WS, name: 'Dev' });
  });

  it('a refused pick says why and keeps the form; a name with a control character disables Add', async () => {
    const { p } = port({ ok: false, code: 'too_large' });
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined, pickFolder: async () => '/src/app' }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(container.querySelector('[data-testid="factory-add-bot-error"]')?.textContent).toBe('settings.factory.pictureTooLarge');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-folder"]')!.click());
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'Dev'));
    expect(submit.disabled).toBe(false);
    await act(async () => typeInto(container.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!, 'a\u0007b'));
    expect(submit.disabled).toBe(true);
    expect(avatarPickError({ ok: false, code: 'unreadable' }, t)).toBe('settings.factory.pictureUnreadable');
    expect(avatarPickError({ ok: false, code: 'cancelled' }, t)).toBeNull();
  });

  it('without a pick port there is no picture row', async () => {
    const p: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), create: vi.fn() };
    await render(createElement(AddBotForm, { port: p, rows: [], t, onDone: () => undefined }));
    expect(container.querySelector('[data-testid="factory-picture-choose"]')).toBeNull();
    expect(container.querySelector('[data-testid="factory-add-bot-name"]')).not.toBeNull();
  });
});

describe('Settings bot list, profile editor and chips', () => {
  const view = {
    version: 1 as const, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
    verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
  };

  it('each row shows its avatar; the editor changes the picture on Save and removes it', async () => {
    useStore.setState({ workspaces: [{ id: WS, name: 'App' }] as never, activeWorkspaceId: WS });
    const rows = [row('bot-00000001', { name: 'Ada', avatar: PICTURE }), row('bot-00000002', { name: '검증봇', role: 'verifier' })];
    const setAvatar = vi.fn(async (_id: string, avatar: string | null) => ({ ok: true as const, bot: { ...rows[0].bot, ...(avatar ? { avatar } : {}) } }));
    const update = vi.fn(async () => ({ ok: true }));
    const pickAvatar = vi.fn(async () => ({ ok: true as const, avatar: `${PICTURE}AA` }));
    const botPort: FactoryBotPort = { available: true, list: async () => rows, subscribe: () => () => undefined, act: async () => ({ ok: true }), update, setAvatar, pickAvatar };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async () => view) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const rowEls = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-row"]')];
    expect(rowEls[0].querySelector('[data-bot-avatar]')?.getAttribute('data-bot-avatar')).toBe('image');
    expect(rowEls[1].querySelector('[data-bot-avatar]')?.textContent).toBe('검');

    // Change: nothing is saved until Save.
    await act(async () => rowEls[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    expect(setAvatar).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="factory-picture-preview"] img')?.getAttribute('src')).toBe(`${PICTURE}AA`);
    // Save is the editor's last button.
    const save = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-editor"] button')].at(-1)!;
    await act(async () => save.click());
    expect(setAvatar).toHaveBeenCalledWith('bot-00000001', `${PICTURE}AA`);
    expect(update).toHaveBeenCalled();

    // Remove.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-bot-row"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-remove"]')!.click());
    const save2 = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-editor"] button')].at(-1)!;
    await act(async () => save2.click());
    expect(setAvatar).toHaveBeenLastCalledWith('bot-00000001', null);

    // A refused profile saves no picture and keeps the editor open.
    update.mockResolvedValueOnce({ ok: false, message: 'budget is malformed or over its caps' } as never);
    setAvatar.mockClear();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-bot-row"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-picture-choose"]')!.click());
    const save3 = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="factory-bot-editor"] button')].at(-1)!;
    await act(async () => save3.click());
    expect(setAvatar).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="factory-bot-editor"]')?.textContent).toContain('budget is malformed');
  });

  it('a chip leads with the bot\'s avatar', async () => {
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(BotChips, { rows: [row('bot-00000001', { name: 'Ada Lovelace' }), row('bot-00000002', { name: 'Moa', avatar: PICTURE })], t, port }));
    const chips = [...container.querySelectorAll('[data-testid="room-bot-chip"]')];
    expect(chips[0].firstElementChild?.getAttribute('data-bot-avatar')).toBe('initials');
    expect(chips[0].firstElementChild?.textContent).toBe('AL');
    expect(chips[1].querySelector('img')?.getAttribute('src')).toBe(PICTURE);
  });
});

describe('RoomCard author', () => {
  const card = (actor: RoomCardData['actor']): RoomCardData => ({
    version: 1, id: 'c-1', seq: 1, workspaceId: WS, threadId: 'general', kind: 'status', at: 1, actor, title: 'Hello',
  });

  it('a bot author gets its 16px avatar; the human and the system none', async () => {
    const bots = [row('bot-00000001', { name: 'Ada', avatar: PICTURE })];
    await render(createElement(RoomCard, { card: card({ kind: 'bot', workspaceId: WS, botId: 'bot-00000001' }), workspaceId: WS, t, bots }));
    const avatar = container.querySelector<HTMLElement>('[data-testid="room-card"] [data-bot-avatar]')!;
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
    expect(avatar.style.width).toBe('16px');
    await render(createElement(RoomCard, { card: card({ kind: 'human' }), workspaceId: WS, t, bots }));
    expect(container.querySelector('[data-testid="room-card"] [data-bot-avatar]')).toBeNull();
  });
});
