// @wmux-lane unit
// `win32` here is a platform name handed to a pure validator; nothing reaches the OS.
import { describe, expect, it } from 'vitest';
import { normalizeCustomAgent, validateCustomAgents, type CustomAgent } from '../customAgents';
import {
  applyFanoutAgentFlags, describeFanoutAgentChoice, describeFanoutRole, fanoutLaunchCustomAgents, normalizeFanoutPreset,
  unresolvedCustomAgent, validateFanoutAgentChoice,
} from '../fanoutPreset';
import { applyRoleAgent, applyRoleBinding, bindingEnforcesModel } from '../orchestratorRole';

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

describe('review round 1', () => {
  it('refuses tokens a pane shell would still read: %, a comma, a leading @ or =, and --%', () => {
    for (const args of ['--%', '%PATH%', '--a,b', '@opts', '=tern', '--x=%HOME%']) {
      expect(code({ name: 'Tern', command: 'tern', args })).toBe('args-invalid');
    }
    expect(code({ name: 'Tern', command: 'tern', args: '--key=value --dir=/tmp/x' })).toBeUndefined();
    expect(code({ name: 'Tern', command: 'tern', unattendedFlags: '--yes,all' })).toBe('flag-invalid');
  });

  it('refuses versioned interpreters, busybox, and a known agent behind trailing dots', () => {
    for (const command of ['python3.12', 'node22', '/usr/bin/perl5.34', 'busybox']) {
      expect(code({ name: 'Tern', command })).toBe('command-generic');
    }
    // Windows runs `codex.exe.` as codex: refused (a trailing dot is never accepted).
    expect(code({ name: 'Tern', command: 'C:/x/codex.exe.' })).toBe('command-invalid');
    expect(code({ name: 'Tern', command: 'C:/x/codex.exe' })).toBe('command-known');
    expect(code({ name: 'Tern', command: 'python-tern' })).toBeUndefined();
  });

  it('refuses a UNC-style path anywhere, and a POSIX path for a Windows pane', () => {
    expect(code({ name: 'Tern', command: '//host/share/tern' })).toBe('command-separator');
    expect(normalizeCustomAgent({ name: 'Tern', command: '/tools/tern' }, { platform: 'win32' })).toMatchObject({ ok: false, code: 'command-posix-path' });
    expect(normalizeCustomAgent({ name: 'Tern', command: '/tools/tern' }, { platform: 'darwin' }).ok).toBe(true);
  });

  it('refuses arguments that carry its own model or prompt flag', () => {
    expect(code({ name: 'Tern', command: 'tern', modelFlag: '--llm', args: '--llm foo' })).toBe('args-flag');
    expect(code({ name: 'Tern', command: 'tern', modelFlag: '--llm', args: '--llm=foo' })).toBe('args-flag');
    expect(code({ name: 'Tern', command: 'tern', promptFlag: '-i', args: '-i' })).toBe('args-flag');
  });

  it('detects a custom pin by its own model flag only, so another CLI meaning of -m does not hide it', () => {
    const llm: CustomAgent = { name: 'Tern', command: 'tern', args: '-m notes', modelFlag: '--llm' };
    const bound = applyRoleBinding('tern -m notes', { agent: 'tern', model: 'm1' }, { spawnedProcess: true, customAgents: [llm] });
    expect(bound).toMatchObject({ command: 'tern -m notes --llm m1', modelInjected: true });
    // A line that already chooses with --llm keeps its own, and says so.
    const typed = applyRoleBinding('tern --llm big', { agent: 'tern', model: 'm1' }, { spawnedProcess: true, customAgents: [llm] });
    expect(typed).toMatchObject({ command: 'tern --llm big', modelInjected: false });
    expect(typed.note).toContain('--llm');
    // The role's own args choosing it: no pin claimed.
    expect(bindingEnforcesModel({ agent: 'tern', model: 'm1', args: '--llm=x' }, [llm])).toBe(false);
    expect(bindingEnforcesModel({ agent: 'tern', model: 'm1' }, [llm])).toBe(true);
  });

  it('stores a hand-edited preset row by the stem, whatever its case', () => {
    expect(normalizeFanoutPreset({ name: 'P', items: [{ agent: 'Tern' }] }, [tern])).toMatchObject({ ok: true, preset: { items: [{ agent: 'tern' }] } });
  });
});

describe('code review', () => {
  // "Gull" is a made-up CLI whose options follow its `chat` subcommand.
  const gull: CustomAgent = { name: 'Gull', command: 'gull', args: 'chat --fast', modelFlag: '-m', unattendedFlags: '--yes' };

  it('places its model and unattended flags after its own Arguments, and does not read a subcommand as prose', () => {
    const swapped = applyRoleAgent('claude "$(cat p.md)"', { agent: 'gull' }, { customAgents: [gull] }).command;
    expect(swapped).toBe('gull chat --fast "$(cat p.md)"');
    // The fan-out seed path: a submitted line, not a spawned process.
    const bound = applyRoleBinding(swapped, { agent: 'gull', model: 'm1' }, { customAgents: [gull] });
    expect(bound).toMatchObject({ command: 'gull chat --fast -m m1 "$(cat p.md)"', modelInjected: true });
    expect(applyFanoutAgentFlags(bound.command, { agent: 'gull', unattended: true }, '/w', 'darwin', [gull]))
      .toBe('gull chat --fast --yes -m m1 "$(cat p.md)"');
  });

  it('shows the approval label as the agent launches', () => {
    expect(describeFanoutAgentChoice({ agent: 'gull', model: 'm1', unattended: true }, [gull])).toBe('gull chat --fast -m m1 --yes');
  });

  it('refuses a stem too long to reference, a trailing dot, more wrappers, and fields of the wrong type', () => {
    expect(code({ name: 'Tern', command: `t${'e'.repeat(48)}rn` })).toBe('command-invalid');
    expect(code({ name: 'Tern', command: 'tern.' })).toBe('command-invalid');
    for (const command of ['wsl', 'tsx', 'pypy3', 'ssh', 'docker']) expect(code({ name: 'Tern', command })).toBe('command-generic');
    expect(code({ name: 'Tern', command: 'tern', args: ['--fast'] })).toBe('args-invalid');
    expect(code({ name: 'Tern', command: 'tern', promptFlag: ['-p'] })).toBe('flag-invalid');
  });
});

describe('launching what was approved', () => {
  it('launches the definitions main approved, not the list as it is now', () => {
    const edited: CustomAgent = { ...tern, args: '--slow' };
    expect(fanoutLaunchCustomAgents([tern], [edited])).toEqual([tern]);
    // Another launcher sends no snapshot: the current list.
    expect(fanoutLaunchCustomAgents(undefined, [edited])).toEqual([edited]);
  });

  it('knows a role bound to a custom agent whose definition is missing', () => {
    expect(unresolvedCustomAgent('tern', [])).toBe(true);
    expect(unresolvedCustomAgent('tern', [tern])).toBe(false);
    expect(unresolvedCustomAgent('claude', [])).toBe(false);
    expect(unresolvedCustomAgent(undefined, [])).toBe(false);
  });

  it('shows a custom role as its command line in the approval, and a missing one as not launching', () => {
    expect(describeFanoutRole('Builder', { agent: 'tern', model: 'm1' }, [tern])).toBe('Builder → /opt/tern/bin/tern --fast -m m1');
    expect(describeFanoutRole('Builder', { agent: 'tern' }, [])).toBe('Builder → tern (no such custom agent: the task will not launch)');
    expect(describeFanoutRole('Builder', { agent: 'codex', model: 'o3' }, [])).toBe('Builder → codex --model o3');
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
    expect(bound.command).toBe('/opt/tern/bin/tern --fast -m m1 -i "$(cat p.md)"');
    expect(bound.optionsInjected).toBeUndefined();
  });

  it('gets unattended flags only when the operator typed some and the preset row turns Unattended on', () => {
    const none = normalizeFanoutPreset({ name: 'P', items: [{ agent: 'tern', unattended: true }] }, [tern]);
    expect(none.ok && none.preset.items).toEqual([{ agent: 'tern' }]);
    const withFlags = { ...tern, unattendedFlags: '--auto-approve' };
    const on = normalizeFanoutPreset({ name: 'P', items: [{ agent: 'tern', unattended: true }] }, [withFlags]);
    expect(on).toMatchObject({ ok: true, preset: { items: [{ agent: 'tern', unattended: true }] } });
    expect(applyFanoutAgentFlags('/opt/tern/bin/tern --fast -i "x"', { agent: 'tern', unattended: true }, '/w', 'darwin', [withFlags]))
      .toBe('/opt/tern/bin/tern --fast --auto-approve -i "x"');
  });
});
