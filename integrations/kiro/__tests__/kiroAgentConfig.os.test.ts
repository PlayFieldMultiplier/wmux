import { describe, it, expect } from 'vitest';
import {
  buildKiroAgentConfig,
  isWmuxOwnedKiroAgent,
  KIRO_AGENT_MANAGED_MARKER,
  INTENDED_DIFFERENCES,
} from '../agent/wmuxAgent.mjs';

const HOME = 'C:\\Users\\someone';

// Values read from a materialized kiro_default (`kiro-cli agent create --from`)
// on 2.15.1. The rule is: equivalent to the built-in except the prompt.
const BUILT_IN_DEFAULTS: Record<string, unknown> = {
  tools: ['*'],
  allowedTools: [],
  toolAliases: {},
  toolsSettings: {},
  mcpServers: {},
  model: null,
  includeMcpJson: true,
};

describe('buildKiroAgentConfig', () => {
  // The one intended difference. Cloning kiro_default's 1.7KB prompt would
  // freeze it at install time and drift as Kiro updates its own; measured 3x on
  // the same tool-using task, thin and built-in both scored 3/3 with no time or
  // cost penalty. A future "let's copy the real prompt for quality" change
  // should have to argue with this test.
  it('ships no prompt of its own', () => {
    expect(buildKiroAgentConfig('/b', HOME).prompt).toBe('');
  });

  // Why approval behaviour cannot change: the built-in pre-approves nothing
  // either, so anything we omit is not more restrictive than the default.
  it('matches the built-in on every field it sets', () => {
    const config = buildKiroAgentConfig('/b', HOME) as Record<string, unknown>;
    for (const [key, builtIn] of Object.entries(BUILT_IN_DEFAULTS)) {
      if (config[key] === undefined) continue; // omitted → Kiro's own default
      expect(config[key], `${key} diverges from kiro_default`).toEqual(builtIn);
    }
  });

  // The two fields an earlier revision dropped. Both are SILENT losses: the
  // agent keeps answering, it just cannot reach wmux's MCP tools and stops
  // seeing the project's docs. The measurement that cleared the empty prompt
  // ran in a temp directory, where neither could have shown up.
  it('keeps the MCP servers the built-in loads', () => {
    expect(buildKiroAgentConfig('/b', HOME).includeMcpJson).toBe(true);
  });

  it('keeps the project context resources the built-in loads', () => {
    const resources = buildKiroAgentConfig('/b', HOME).resources as string[];
    expect(resources).toContain('file://AGENTS.md');
    expect(resources).toContain('file://README.md');
    expect(resources).toContain('skill://.kiro/skills/*/SKILL.md');
    // The globs Kiro bakes with an absolute home — hence a `home` parameter
    // instead of a hardcoded list.
    expect(resources.some((r) => r.startsWith('skill://') && r.includes(HOME))).toBe(true);
    expect(resources.some((r) => r.startsWith('file://') && r.includes('steering'))).toBe(true);
  });

  it('registers only the triggers wmux can act on', () => {
    // userPromptSubmit exists in Kiro and is deliberately absent: no
    // approval-specific event means no honest awaiting_input (#898).
    expect(Object.keys(buildKiroAgentConfig('/b', HOME).hooks as object).sort())
      .toEqual(['agentSpawn', 'stop']);
  });

  // Kiro's hook timeout defaults to 10s; the bridge caps itself at 2s. The
  // configured value has to sit between them so our cap fires first and Kiro's
  // is a real backstop rather than a ten-second stall.
  it('gives Kiro a backstop just above the bridge cap', () => {
    const hooks = buildKiroAgentConfig('/b', HOME).hooks as Record<string, Array<{ timeout_ms: number }>>;
    for (const trigger of ['stop', 'agentSpawn']) {
      expect(hooks[trigger][0].timeout_ms).toBeGreaterThan(2000);
      expect(hooks[trigger][0].timeout_ms).toBeLessThan(10_000);
    }
  });

  const commandFor = (bridge: string, platform: string) => {
    const hooks = buildKiroAgentConfig(bridge, HOME, { platform }).hooks as
      Record<string, Array<{ command: string }>>;
    expect(hooks.agentSpawn[0].command).toBe(hooks.stop[0].command);
    return hooks.stop[0].command;
  };

  it('quotes the bridge path on POSIX so a space in it survives', () => {
    expect(commandFor('/Users/some one/.wmux/hooks/b.mjs', 'darwin')).toBe('node "/Users/some one/.wmux/hooks/b.mjs"');
    expect(commandFor('/home/someone/.wmux/hooks/b.mjs', 'linux')).toBe('node "/home/someone/.wmux/hooks/b.mjs"');
  });

  // #1917: Kiro runs a Windows hook through `cmd /C` with Rust's argument
  // quoting, which delivers any quote in the line to node as a literal one.
  // The Windows line is therefore unquoted, with forward slashes, which every
  // shell that might run it verbatim also reads the same way.
  it('writes the Windows bridge path unquoted, with forward slashes', () => {
    expect(commandFor('C:\\Users\\someone\\.wmux\\hooks\\b.mjs', 'win32')).toBe('node C:/Users/someone/.wmux/hooks/b.mjs');
    expect(commandFor('C:/wmux-hooks/b.mjs', 'win32')).toBe('node C:/wmux-hooks/b.mjs');
    expect(commandFor('C:\\Users\\RUNNER~1\\x_y.z+1\\b.mjs', 'win32')).toBe('node C:/Users/RUNNER~1/x_y.z+1/b.mjs');
    // Rooted on the current drive: absolute enough to name one file.
    expect(commandFor('/bridge.mjs', 'win32')).toBe('node /bridge.mjs');
  });

  it('accepts letters in any script on Windows', () => {
    expect(commandFor('C:\\Users\\김철수\\.wmux\\hooks\\b.mjs', 'win32')).toBe('node C:/Users/김철수/.wmux/hooks/b.mjs');
    expect(commandFor('C:\\Users\\Zoë\\Привет\\b.mjs', 'win32')).toBe('node C:/Users/Zoë/Привет/b.mjs');
  });

  it('refuses a Windows path no unquoted form can carry, and names a way out', () => {
    for (const bad of [
      'C:\\Program Files\\wmux\\b.mjs',
      'C:\\Users\\some\tone\\b.mjs',
      'C:\\Users\\some　one\\b.mjs', // ideographic space
      'C:\\a"b\\b.mjs',
      "C:\\Users\\O'Brien\\b.mjs",
      'C:\\a&b\\b.mjs',
      'C:\\a(1)\\b.mjs',
      'C:\\100%\\b.mjs',
      'C:\\a$b\\b.mjs',
      'C:\\a;b\\b.mjs',
      'C:\\a,b\\b.mjs',
      'C:\\a^b\\b.mjs',
      'C:\\a!b\\b.mjs',
      '',
      // Not absolute: each would resolve against the hook's working folder.
      'hooks\\b.mjs',
      'C:b.mjs',
      '~/b.mjs',
      '-r/b.mjs',
    ]) {
      expect(() => buildKiroAgentConfig(bad, HOME, { platform: 'win32' }), JSON.stringify(bad))
        .toThrow(/no spaces[\s\S]*C:\/wmux-hooks\//);
    }
  });

  it('declares exactly the fields it means to differ on', () => {
    // Guards the equivalence checker's allowlist: adding a field here without
    // thinking is how "equivalent except the prompt" quietly stops being true.
    expect(INTENDED_DIFFERENCES).toEqual(['name', 'description', 'prompt', 'hooks']);
  });
});

describe('isWmuxOwnedKiroAgent', () => {
  // An installer must never replace a file it cannot prove it wrote.
  it('recognises our own config', () => {
    expect(isWmuxOwnedKiroAgent(buildKiroAgentConfig('/b', HOME))).toBe(true);
  });

  it('refuses anything else, including a same-named user agent', () => {
    for (const other of [null, undefined, 'x', 42, [], {}, { name: 'wmux' },
      { name: 'wmux', description: 'mine' }]) {
      expect(isWmuxOwnedKiroAgent(other), JSON.stringify(other)).toBe(false);
    }
    expect(isWmuxOwnedKiroAgent({ description: KIRO_AGENT_MANAGED_MARKER })).toBe(true);
  });
});
