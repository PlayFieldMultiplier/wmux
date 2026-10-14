// The bot the phone talks to: pinned, else the oldest Coordinator, else the
// oldest enabled bot (no workspace is special).
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
  const other = bot('bot-00000004', { workspaceId: 'ws-b', createdAt: 0 });

  it('takes the pinned bot while it is enabled', () => {
    expect(phoneBot([lead, coordOld, other], { phoneBotId: lead.id })?.id).toBe(lead.id);
  });

  it('falls back when the pin names a disabled or missing bot', () => {
    expect(phoneBot([{ ...lead, enabled: false }, coordOld], { phoneBotId: lead.id })?.id).toBe(coordOld.id);
    expect(phoneBot([coordOld], { phoneBotId: 'bot-0000dead' })?.id).toBe(coordOld.id);
  });

  it('defaults to the oldest enabled Coordinator, a legacy moa bot included', () => {
    expect(phoneBot([lead, coordNew, coordOld, other], {})?.id).toBe(coordOld.id);
    const legacyMoa = bot('bot-00000006', { role: 'moa', createdAt: 7 });
    expect(phoneBot([lead, legacyMoa], {})?.id).toBe(legacyMoa.id);
  });

  it('else the oldest enabled bot in any workspace, else none', () => {
    expect(phoneBot([lead, { ...coordOld, enabled: false }, other], {})?.id).toBe(other.id);
    expect(phoneBot([lead], {})?.id).toBe(lead.id);
    expect(phoneBot([{ ...lead, enabled: false }], {})).toBeNull();
  });
});
