import { describe, expect, it } from 'vitest';
import { normalizeCustomAgent, validateCustomAgents, type CustomAgent } from '../customAgents';
import { applyFanoutAgentFlags, normalizeFanoutPreset, validateFanoutAgentChoice } from '../fanoutPreset';
import { applyRoleAgent, applyRoleBinding } from '../orchestratorRole';

// "Tern" is a made-up CLI: no real agent is named in these fixtures.
const tern: CustomAgent = { name: 'Tern', command: '/opt/tern/bin/tern', args: '--fast', promptFlag: '-i', modelFlag: '-m' };

const code = (input: unknown): string | undefined => {
  const r = normalizeCustomAgent(input);
  return r.ok ? undefined : r.code;
};

describe('normalizeCustomAgent', () => {
  it('takes a program name, or an absolute path the user typed, and refuses any other path', () => {
    expect(normalizeCustomAgent({ name: 'Tern', command: 'tern' })).toEqual({ ok: true, agent: { name: 'Tern', command: 'tern' } });
    expect(code({ name: 'Tern', command: '/opt/tern/bin/tern' })).toBeUndefined();
    expect(code({ name: 'Tern', command: 'C:\\Tools\\Tern\\tern.exe' })).toBeUndefined();
    expect(code({ name: 'Tern', command: 'bin/tern' })).toBe('command-separator');
    expect(code({ name: 'Tern', command: '.\\tern.exe' })).toBe('command-separator');
    expect(code({ name: 'Tern', command: '/opt/../bin/tern' })).toBe('command-separator');
  });

  it('refuses shell syntax, spaces and quotes in the command, arguments and flags', () => {
    expect(code({ name: 'Tern', command: 'tern;rm' })).toBe('command-invalid');
    expect(code({ name: 'Tern', command: '$(tern)' })).toBe('command-invalid');
    expect(code({ name: 'Tern', command: '/opt/my tools/tern' })).toBe('command-invalid');
    expect(code({ name: 'Tern', command: 'tern', args: '--profile "a b"' })).toBe('args-invalid');
    expect(code({ name: 'Tern', command: 'tern', args: '--out $HOME' })).toBe('args-invalid');
    expect(code({ name: 'Tern', command: 'tern', args: 'x|y' })).toBe('args-invalid');
    expect(code({ name: 'Tern', command: 'tern', promptFlag: 'i' })).toBe('flag-invalid');
    expect(code({ name: 'Tern', command: 'tern', modelFlag: '--model x' })).toBe('flag-invalid');
    expect(code({ name: 'Tern', command: 'tern', unattendedFlags: 'yes' })).toBe('flag-invalid');
    expect(code({ name: 'Tern', command: 'tern', unattendedFlags: '--auto;x' })).toBe('flag-invalid');
  });

  it('refuses a command whose name is an agent wmux knows, or a program that runs other programs', () => {
    expect(code({ name: 'Mine', command: 'claude' })).toBe('command-known');
    // Case and the Windows extension are ignored, as the process tracker does.
    expect(code({ name: 'Mine', command: 'C:\\bin\\Codex.EXE' })).toBe('command-known');
    // A launcher that differs from its slug (kiro ships `kiro-cli`).
    expect(code({ name: 'Mine', command: '/usr/local/bin/kiro-cli' })).toBe('command-known');
    expect(code({ name: 'Mine', command: 'node' })).toBe('command-generic');
  });

  it('keeps no field the operator did not fill: no unattended flags means none', () => {
    const r = normalizeCustomAgent({ name: 'Tern', command: 'tern', args: '', unattendedFlags: '  ' });
    expect(r).toEqual({ ok: true, agent: { name: 'Tern', command: 'tern' } });
    expect(code({ name: 'Tern', command: 'tern', process: 'tern' })).toBe('unknown-field');
  });
});

describe('validateCustomAgents', () => {
  it('refuses a duplicate name and two agents running the same program, case-insensitive', () => {
    const dupName = validateCustomAgents([{ name: 'Tern', command: 'tern' }, { name: 'tern', command: 'gull' }]);
    expect(dupName).toMatchObject({ ok: false, code: 'name-duplicate' });
    const dupStem = validateCustomAgents([{ name: 'Tern', command: 'tern' }, { name: 'Tern 2', command: '/opt/x/TERN.exe' }]);
    expect(dupStem).toMatchObject({ ok: false, code: 'command-duplicate', params: { stem: 'tern' } });
  });
});

describe('a custom agent on the launch path', () => {
  it('is reached only through the operator list: a caller naming it without the list is refused', () => {
    expect(validateFanoutAgentChoice({ agent: 'tern' })).toMatchObject({ ok: false, code: 'agent-unknown' });
    expect(validateFanoutAgentChoice({ agent: 'tern', model: 'm1' }, { customAgents: [tern] }))
      .toEqual({ ok: true, choice: { agent: 'tern', model: 'm1' } });
  });

  it('launches as typed, with its own prompt and model flags, and never a permission flag', () => {
    const swap = applyRoleAgent('claude "$(cat p.md)"', { agent: 'tern' }, { customAgents: [tern] });
    expect(swap.command).toBe('/opt/tern/bin/tern --fast -i "$(cat p.md)"');
    const bound = applyRoleBinding(swap.command, { agent: 'tern', model: 'm1', skipPermissions: true }, {
      spawnedProcess: true,
      customAgents: [tern],
    });
    expect(bound.command).toBe('/opt/tern/bin/tern -m m1 --fast -i "$(cat p.md)"');
    expect(bound.optionsInjected).toBeUndefined();
  });

  it('gets unattended flags only when the operator typed some and the preset row turns Unattended on', () => {
    const none = normalizeFanoutPreset({ name: 'P', items: [{ agent: 'tern', unattended: true }] }, [tern]);
    expect(none.ok && none.preset.items).toEqual([{ agent: 'tern' }]);
    const withFlags = { ...tern, unattendedFlags: '--auto-approve' };
    const on = normalizeFanoutPreset({ name: 'P', items: [{ agent: 'tern', unattended: true }] }, [withFlags]);
    expect(on).toMatchObject({ ok: true, preset: { items: [{ agent: 'tern', unattended: true }] } });
    expect(applyFanoutAgentFlags('/opt/tern/bin/tern --fast -i "x"', { agent: 'tern', unattended: true }, '/w', 'darwin', [withFlags]))
      .toBe('/opt/tern/bin/tern --auto-approve --fast -i "x"');
  });
});
