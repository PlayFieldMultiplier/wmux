import { describe, expect, it } from 'vitest';
import {
  BOT_BASE_RPC,
  BOT_TEARDOWN_DENY,
  BOT_TOOL_RPC,
  FACTORY_RPC_METHODS,
  ROLE_SURFACES,
  botSurfaceRefusal,
  factoryNotImplemented,
} from '../botSurface';
import { BOT_ROLES, type BotRole } from '../bot';
import { ALL_RPC_METHODS } from '../rpc';
import { COMMANDER_RPC_METHODS, COMMANDER_TOOL_SURFACE, COMMANDER_ONLY_TOOLS } from '../commanderSurface';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';
import { METHOD_CAPABILITY, resolveRequiredCapability } from '../../main/mcp/methodCapabilityMap';
import type { RpcMethod } from '../rpc';

const COMMON = ['ask_person', 'room_post', 'room_read', 'handoff_send', 'fact_poll'];

describe('ROLE_SURFACES', () => {
  it('defines every role', () => {
    expect(Object.keys(ROLE_SURFACES).sort()).toEqual([...BOT_ROLES].sort());
  });

  it.each(BOT_ROLES)('%s holds the tools every role has', (role) => {
    for (const tool of COMMON) expect(ROLE_SURFACES[role].tools.has(tool), `${role} lacks ${tool}`).toBe(true);
  });

  it.each(BOT_ROLES)('%s holds no shell, terminal input, teardown, browser or computer tool', (role) => {
    for (const tool of ROLE_SURFACES[role].tools) {
      expect(tool).not.toMatch(/^(terminal_send|terminal_send_key|send_message|pane_close|surface_close|workspace_close|pane_split|surface_new|computer|approval_press|task_close|task_pr|task_adopt)$/);
      expect(tool).not.toMatch(/^(browser_|repl_|company_)/);
    }
  });

  it('pr_verdict is the verifier\'s alone', () => {
    for (const role of BOT_ROLES) {
      expect(ROLE_SURFACES[role].tools.has('pr_verdict')).toBe(role === 'verifier');
      expect(ROLE_SURFACES[role].rpc.has('verify.recordVerdict')).toBe(role === 'verifier');
    }
  });

  it('moa has no fan-out and no code tools; the others fan out with their own preset', () => {
    expect(ROLE_SURFACES.moa.tools.has('fanout_start')).toBe(false);
    expect(ROLE_SURFACES.moa.rpc.has('task.fanout.start')).toBe(false);
    expect(ROLE_SURFACES.moa.fanoutPresets).toEqual([]);
    for (const role of ['lead', 'triage', 'verifier', 'maintainer'] as const) {
      expect(ROLE_SURFACES[role].tools.has('fanout_start')).toBe(true);
      expect(ROLE_SURFACES[role].fanoutPresets.length).toBeGreaterThan(0);
    }
    expect(ROLE_SURFACES.verifier.fanoutPresets).toEqual(['verify']);
  });

  it('plan_propose, bot_list and bot_park are moa\'s alone', () => {
    for (const role of BOT_ROLES) {
      for (const tool of ['plan_propose', 'bot_list', 'bot_park']) {
        expect(ROLE_SURFACES[role].tools.has(tool)).toBe(role === 'moa');
      }
    }
  });

  it.each(BOT_ROLES)('%s rpc = base ∪ the methods of its tools, exactly', (role) => {
    const expected = new Set<string>(BOT_BASE_RPC);
    for (const tool of ROLE_SURFACES[role].tools) {
      for (const m of BOT_TOOL_RPC[tool as keyof typeof BOT_TOOL_RPC]) expected.add(m);
    }
    expect(new Set(ROLE_SURFACES[role].rpc)).toEqual(expected);
  });

  it.each(BOT_ROLES)('%s reaches no teardown method and no operator-only factory method', (role) => {
    for (const m of BOT_TEARDOWN_DENY) expect(ROLE_SURFACES[role].rpc.has(m)).toBe(false);
    for (const m of ['bot.create', 'bot.update', 'bot.remove', 'bot.wake', 'bot.resume', 'bot.interrupt', 'bot.status',
      'room.resolve', 'handoff.answer', 'handoff.list', 'fact.emit', 'input.send', 'input.sendKey']) {
      expect(ROLE_SURFACES[role].rpc.has(m), `${role} reaches ${m}`).toBe(false);
    }
  });

  it('every surface method is a mapped RpcMethod the bundled server is allowed to call', () => {
    for (const role of BOT_ROLES) {
      for (const m of ROLE_SURFACES[role].rpc) {
        expect(m in METHOD_CAPABILITY, `${m} has no capability entry`).toBe(true);
        const bootstrap = resolveRequiredCapability(METHOD_CAPABILITY[m as RpcMethod], {}) === null;
        expect(
          bootstrap || FIRST_PARTY_METHODS.has(m as RpcMethod),
          `${m} (on the ${role} surface) is neither identity bootstrap nor first-party`,
        ).toBe(true);
      }
    }
  });

  it('existing tool names on a surface are tools the commander profile already registers', () => {
    const existing = new Set([...COMMANDER_TOOL_SURFACE, ...COMMANDER_ONLY_TOOLS]);
    for (const tool of ['workspace_list', 'pane_list', 'terminal_read', 'fleet_triage', 'ledger_update', 'fanout_start', 'wmux_events_poll', 'a2a_task_query']) {
      expect(existing.has(tool), tool).toBe(true);
      for (const m of BOT_TOOL_RPC[tool as keyof typeof BOT_TOOL_RPC]) {
        expect(COMMANDER_RPC_METHODS.has(m), `${tool} → ${m}`).toBe(true);
      }
    }
  });

  it('FACTORY_RPC_METHODS are unique RpcMethods in ALL_RPC_METHODS', () => {
    const all = new Set<string>(ALL_RPC_METHODS);
    expect(new Set(FACTORY_RPC_METHODS).size).toBe(FACTORY_RPC_METHODS.length);
    for (const m of FACTORY_RPC_METHODS) {
      expect(all.has(m), m).toBe(true);
      expect(METHOD_CAPABILITY[m]).toEqual({ capability: 'wmux.internal' });
    }
  });
});

describe('botSurfaceRefusal', () => {
  it('passes a method on the role surface', () => {
    expect(botSurfaceRefusal('verifier', 'verify.recordVerdict')).toBeNull();
    expect(botSurfaceRefusal('moa', 'plan.propose')).toBeNull();
    expect(botSurfaceRefusal('lead', 'mcp.identify')).toBeNull();
  });

  it('refuses a method off the role surface', () => {
    expect(botSurfaceRefusal('lead', 'verify.recordVerdict')).toBe('surface');
    expect(botSurfaceRefusal('moa', 'task.fanout.start')).toBe('surface');
    expect(botSurfaceRefusal('verifier', 'input.send')).toBe('surface');
    expect(botSurfaceRefusal('lead', 'bot.create')).toBe('surface');
  });

  it('names teardown first', () => {
    expect(botSurfaceRefusal('lead', 'pane.close')).toBe('teardown');
    expect(botSurfaceRefusal('moa', 'workspace.close')).toBe('teardown');
  });

  it('fails closed for a role that is not one', () => {
    expect(botSurfaceRefusal('wizard' as BotRole, 'mcp.identify')).toBe('surface');
  });
});

describe('factoryNotImplemented', () => {
  it('is a typed refusal result', () => {
    expect(factoryNotImplemented('room.post')).toEqual({
      ok: false,
      code: 'not_implemented',
      method: 'room.post',
      message: 'room.post is not available in this build',
    });
  });
});
