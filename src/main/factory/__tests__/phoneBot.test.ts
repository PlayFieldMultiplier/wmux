// The bot the phone talks to: pinned, else the oldest Coordinator, else the
// oldest bot of the HQ room.
import { describe, expect, it } from 'vitest';
import { phoneBot } from '../phoneBot';
import type { BotProfile } from '../../../shared/bot';

function bot(id: string, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: 'ws-a', role: 'lead', name: id,
    engine: { kind: 'claude-sdk' } as BotProfile['engine'], triggers: [], budget: {} as BotProfile['budget'],
    enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('phoneBot', () => {
  const lead = bot('bot-00000001', { createdAt: 1 });
  const coordNew = bot('bot-00000002', { template: 'coordinator', role: 'moa', createdAt: 5 });
  const coordOld = bot('bot-00000003', { template: 'coordinator', role: 'moa', createdAt: 3 });
  const hqOld = bot('bot-00000004', { workspaceId: 'ws-hq', createdAt: 2 });
  const hqNew = bot('bot-00000005', { workspaceId: 'ws-hq', createdAt: 9 });

  it('takes the pinned bot while it is enabled', () => {
    expect(phoneBot([lead, coordOld, hqOld], { phoneBotId: lead.id, hqWorkspaceId: 'ws-hq' })?.id).toBe(lead.id);
  });

  it('falls back when the pin names a disabled or missing bot', () => {
    expect(phoneBot([{ ...lead, enabled: false }, coordOld], { phoneBotId: lead.id, hqWorkspaceId: null })?.id).toBe(coordOld.id);
    expect(phoneBot([coordOld], { phoneBotId: 'bot-0000dead', hqWorkspaceId: null })?.id).toBe(coordOld.id);
  });

  it('defaults to the oldest enabled Coordinator, a legacy moa bot included', () => {
    expect(phoneBot([lead, coordNew, coordOld, hqOld], { hqWorkspaceId: 'ws-hq' })?.id).toBe(coordOld.id);
    const legacyMoa = bot('bot-00000006', { role: 'moa', createdAt: 7 });
    expect(phoneBot([lead, legacyMoa], { hqWorkspaceId: null })?.id).toBe(legacyMoa.id);
    expect(phoneBot([lead, { ...coordOld, enabled: false }, hqNew, hqOld], { hqWorkspaceId: 'ws-hq' })?.id).toBe(hqOld.id);
  });

  it('else the oldest enabled bot of the HQ room, else none', () => {
    expect(phoneBot([lead, hqNew, hqOld], { hqWorkspaceId: 'ws-hq' })?.id).toBe(hqOld.id);
    expect(phoneBot([lead], { hqWorkspaceId: 'ws-hq' })).toBeNull();
    expect(phoneBot([lead], { hqWorkspaceId: null })).toBeNull();
  });
});
