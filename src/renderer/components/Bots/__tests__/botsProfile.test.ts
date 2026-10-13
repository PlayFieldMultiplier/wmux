// What a bot's profile says it can do comes from the shared surface alone:
// every surface tool has a phrase or is a listed event feed, every bot shows
// the same powers, and only a Coordinator adds reads in every workspace.

import { describe, expect, it } from 'vitest';
import { SHARED_SURFACE } from '../../../../shared/botSurface';
import { BOT_ROLES } from '../../../../shared/bot';
import { en } from '../../../i18n/locales/en';
import { CAN_DO_COORDINATOR, CAN_DO_PHRASES, CAN_DO_UNLISTED, botCanDo } from '../botsProfile';

describe('bot profile: can do', () => {
  it('every tool on the surface has an owner phrase or is an event feed', () => {
    const phrased = new Set(CAN_DO_PHRASES.flatMap((p) => p.tools as readonly string[]));
    for (const tool of SHARED_SURFACE.tools) {
      expect(phrased.has(tool) || CAN_DO_UNLISTED.has(tool as never), tool).toBe(true);
    }
  });

  it('shows the same powers for every role tag, each phrase backed by a surface tool and an English string', () => {
    const lead = botCanDo({ role: 'lead' });
    for (const role of BOT_ROLES.filter((r) => r !== 'moa')) expect(botCanDo({ role })).toEqual(lead);
    for (const key of lead) {
      const phrase = CAN_DO_PHRASES.find((p) => p.key === key);
      expect(phrase?.tools.some((t) => SHARED_SURFACE.tools.has(t)), key).toBe(true);
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
    for (const key of ['botsPage.canDo.fanout', 'botsPage.canDo.verdict', 'botsPage.canDo.plan', 'botsPage.canDo.ask', 'botsPage.canDo.approval', 'botsPage.canDo.secrets']) {
      expect(lead).toContain(key);
    }
  });

  it('only a Coordinator (template, or a legacy Moa) reads every workspace', () => {
    expect(en[CAN_DO_COORDINATOR as keyof typeof en]).toBeTruthy();
    expect(botCanDo({ role: 'lead' })).not.toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'lead', template: 'coordinator' })).toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'moa' })).toContain(CAN_DO_COORDINATOR);
    expect(botCanDo({ role: 'moa', template: 'developer' })).not.toContain(CAN_DO_COORDINATOR);
  });
});
