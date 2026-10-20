import { describe, expect, it } from 'vitest';
import { isOlderVersion, parseAgentVersion } from '../agentSetup';

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
