import { describe, expect, it } from 'vitest';
import { anyAgentReady, anyAgentSetUp, isOlderVersion, parseAgentVersion, shownAgentIds, type AgentSetupStatus } from '../agentSetup';

describe('agent version helpers', () => {
  it('reads the version from each agent\'s --version line', () => {
    expect(parseAgentVersion('2.1.305 (Claude Code)')).toBe('2.1.305');
    expect(parseAgentVersion('codex-cli 0.163.0')).toBe('0.163.0');
    expect(parseAgentVersion('no version here')).toBeNull();
  });

  it('compares numerically, not as text', () => {
    expect(isOlderVersion('2.1.99', '2.1.236')).toBe(true);
    expect(isOlderVersion('2.1.236', '2.1.236')).toBe(false);
    expect(isOlderVersion('0.163.0', '0.157.0')).toBe(false);
    expect(isOlderVersion('0.9.0', '0.157.0')).toBe(true);
  });
});

describe('anyAgentSetUp', () => {
  const st = (agent: AgentSetupStatus['agent'], readiness: AgentSetupStatus['readiness']): AgentSetupStatus => ({
    agent, readiness, executable: null, version: null, updateRecommended: false, loginKnown: readiness !== 'installed', candidates: [],
  });
  it('counts a signed-in agent or one installed with an uncheckable sign-in; anyAgentReady still counts only signed in', () => {
    const installedOnly = [st('claude', 'not-installed'), st('codex', 'login-needed'), st('grok', 'installed')];
    expect(anyAgentSetUp(installedOnly)).toBe(true);
    expect(anyAgentReady(installedOnly)).toBe(false);
    expect(anyAgentSetUp([st('claude', 'login-needed'), st('agy', 'not-installed')])).toBe(false);
    expect(anyAgentSetUp([st('codex', 'ready')])).toBe(true);
  });
});

describe('shownAgentIds', () => {
  const st = (agent: AgentSetupStatus['agent'], readiness: AgentSetupStatus['readiness']): AgentSetupStatus => ({
    agent, readiness, executable: null, version: null, updateRecommended: false, loginKnown: false, candidates: [],
  });
  const original = ['claude', 'codex', 'grok', 'agy', 'qwen', 'kimi'];

  it('always shows the original six cards, installed or not', () => {
    expect(shownAgentIds(null)).toEqual(original);
    expect(shownAgentIds(original.map((a) => st(a as AgentSetupStatus['agent'], 'not-installed')))).toEqual(original);
  });

  it('shows a newer agent only once it is found, in registry order', () => {
    const absent = (['copilot', 'amp', 'droid', 'pi', 'cursor-agent'] as const).map((a) => st(a, 'not-installed'));
    expect(shownAgentIds(absent)).toEqual(original);
    expect(shownAgentIds([...absent.filter((s) => s.agent !== 'pi' && s.agent !== 'copilot'), st('pi', 'installed'), st('copilot', 'login-needed')]))
      .toEqual(['claude', 'codex', 'copilot', 'grok', 'agy', 'qwen', 'kimi', 'pi']);
  });
});
