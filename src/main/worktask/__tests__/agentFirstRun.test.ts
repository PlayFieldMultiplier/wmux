import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_FIRST_RUN_ENV,
  CLAUDE_SANDBOXED_ENV,
  FIRST_RUN_DISMISS_KEY,
  clearFirstRunPrompts,
  detectFirstRunPrompt,
  firstRunEnvForAgent,
  watchFolderTrust,
  launcherStem,
  type FirstRunPort,
} from '../agentFirstRun';

/** The trust dialog as Claude Code 2.1.260 renders it (spike capture). */
const TRUST_SCREEN = [
  'Accessing workspace:',
  '/tmp/wt/task-slug',
  '',
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  '❯ 1. No, exit',
  '  2. Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

/** The fullscreen-renderer upsell, reproduced during the spike. */
const UPSELL_SCREEN = [
  'Try the new fullscreen renderer?',
  '· Flicker-free output',
  '',
  '❯ 1. Yes, try it',
  '  2. Not now',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

/** An AskUserQuestion prompt: same shape, and it must NEVER be dismissed here. */
const ASK_USER_QUESTION_SCREEN = [
  '│ Which migration should I run first?',
  '│ ❯ 1. The users table',
  '│   2. The orders table',
  '│ Enter to confirm · Esc to cancel',
].join('\n');

/** Gemini CLI and Qwen Code folder-trust dialogs (live captures). */
const folderTrust = (name: string): string =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../daemon/approvals/__tests__/fixtures/folder-trust', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen.join('\n');

const READY_SCREEN = ['❯ Try "write a test for <filepath>"', '⏵⏵ auto mode on · ← for agents'].join('\n');

/** F15 — the first turn's model rejection, verbatim from the wave 3 dogfood
 *  (the operator's ~/.zshrc exported ANTHROPIC_MODEL=glm-5.3). No menu, no
 *  footer, nothing to press: only reportable. */
const MODEL_ERROR_SCREEN = [
  '> implement the lane',
  '',
  "There's an issue with the selected model (glm-5.3)",
  '',
  '❯ ',
].join('\n');

describe('launcherStem', () => {
  it('reduces a launch command to its agent stem', () => {
    expect(launcherStem('claude')).toBe('claude');
    expect(launcherStem('/opt/bin/claude --model opus')).toBe('claude');
    expect(launcherStem('C:\\bin\\claude.cmd "$(cat x)"')).toBe('claude');
    expect(launcherStem('codex --model o3')).toBe('codex');
    expect(launcherStem('')).toBe('');
  });
});

describe('firstRunEnvForAgent', () => {
  it('gives a claude worker the sandboxed flag that skips the trust dialog', () => {
    expect(firstRunEnvForAgent('claude "$(cat /tmp/p.md)"', {})).toEqual({
      [CLAUDE_SANDBOXED_ENV]: '1',
    });
  });

  it('leaves every other agent alone', () => {
    expect(firstRunEnvForAgent('codex', {})).toEqual({});
    expect(firstRunEnvForAgent('gemini --yolo', {})).toEqual({});
  });

  it('honours the opt-out', () => {
    expect(firstRunEnvForAgent('claude', { [AGENT_FIRST_RUN_ENV]: 'off' })).toEqual({});
    expect(firstRunEnvForAgent('claude', { [AGENT_FIRST_RUN_ENV]: '0' })).toEqual({});
    expect(firstRunEnvForAgent('claude', { [AGENT_FIRST_RUN_ENV]: 'on' })).toEqual({
      [CLAUDE_SANDBOXED_ENV]: '1',
    });
  });
});

describe('detectFirstRunPrompt', () => {
  it('recognises the trust dialog', () => {
    expect(detectFirstRunPrompt(TRUST_SCREEN)?.kind).toBe('trust');
  });

  it('recognises a known one-shot interstitial', () => {
    const found = detectFirstRunPrompt(UPSELL_SCREEN);
    expect(found?.kind).toBe('interstitial');
    expect(found?.headline).toBe('fullscreen renderer upsell');
  });

  it('does NOT match an agent question that merely has the same shape', () => {
    expect(detectFirstRunPrompt(ASK_USER_QUESTION_SCREEN)).toBeNull();
  });

  it('does not match a working pane or an empty read', () => {
    expect(detectFirstRunPrompt(READY_SCREEN)).toBeNull();
    expect(detectFirstRunPrompt('')).toBeNull();
  });

  // F15 — the screen three dogfood runs actually died on.
  it('recognises the selected-model error and names the model', () => {
    const found = detectFirstRunPrompt(MODEL_ERROR_SCREEN);
    expect(found?.kind).toBe('model-error');
    expect(found?.headline).toBe('selected-model error');
    expect(found?.model).toBe('glm-5.3');
  });

  it('recognises the message with no model in parentheses', () => {
    const found = detectFirstRunPrompt("There's an issue with the selected model");
    expect(found?.kind).toBe('model-error');
    expect(found?.model).toBeUndefined();
  });

  it('does NOT read the worker\'s own echoed prompt as the agent speaking', () => {
    // A fan-out task ABOUT this bug quotes the message verbatim, and the pane
    // echoes the prompt back — including the continuation lines, which carry no
    // `>` of their own and are told apart only by their indent.
    const echoed = [
      '> Fix the fan-out worker launch: every worker answers',
      "  There's an issue with the selected model (glm-5.3)",
      '  and needs /model opus by hand.',
      '',
      '⏺ Reading src/main/worktask/FanOutService.ts',
      '❯ ',
    ].join('\n');
    expect(detectFirstRunPrompt(echoed)).toBeNull();
  });

  it('does not match the phrase quoted mid-sentence', () => {
    expect(
      detectFirstRunPrompt('The pane said there\'s an issue with the selected model, so I retried.'),
    ).toBeNull();
  });

  it('does not match an error scrolled out of the tail', () => {
    const old = ["There's an issue with the selected model (glm-5.3)", ...Array(12).fill('working…')].join('\n');
    expect(detectFirstRunPrompt(old)).toBeNull();
  });
});

/** A scripted pane: each read returns the next screen, then the last one repeats. */
function scriptedPort(screens: string[]): FirstRunPort & { keys: string[] } {
  const keys: string[] = [];
  let i = 0;
  return {
    keys,
    readScreen: async (): Promise<string> => {
      const screen = screens[Math.min(i, screens.length - 1)] ?? '';
      i += 1;
      return screen;
    },
    sendKey: async (_ptyId, sequence): Promise<void> => {
      keys.push(sequence);
    },
  };
}

const fastOptions = {
  pollMs: 0,
  watchMs: 0,
  deadlineMs: 50,
  sleep: async (): Promise<void> => { /* no waiting in tests */ },
  log: (): void => { /* silent */ },
  now: ((): (() => number) => {
    let t = 0;
    return () => (t += 10);
  })(),
};

describe('detectFirstRunPrompt: other agents\' folder-trust dialogs', () => {
  it.each([
    ['gemini-folder-trust-120x40', 'gemini folder trust dialog'],
    ['gemini-folder-trust-22x30', 'gemini folder trust dialog'],
    // Choices too narrow to read: still the dialog, still never answered.
    ['gemini-folder-trust-18x60', 'gemini folder trust dialog'],
    ['qwen-folder-trust-60x30', 'qwen folder trust dialog'],
    ['qwen-folder-trust-18x60', 'qwen folder trust dialog'],
  ])('recognises %s without a confirm footer', (name, headline) => {
    expect(detectFirstRunPrompt(folderTrust(name))).toEqual({ kind: 'trust', headline });
  });

  it('leaves a dialog already answered, and a reply quoting the question, alone', () => {
    expect(detectFirstRunPrompt(folderTrust('gemini-folder-trust-answered-120x40'))).toBeNull();
    expect(detectFirstRunPrompt([
      '✦ When Gemini asks "Do you trust the files in this folder?" pick one of:',
      '● 1. Trust folder (proj)',
      '  2. Trust parent folder (work)',
      "  3. Don't trust",
    ].join('\n'))).toBeNull();
  });
});

describe('clearFirstRunPrompts', () => {
  it('dismisses a known interstitial with ESC and reports it answered', async () => {
    const port = scriptedPort([UPSELL_SCREEN, READY_SCREEN, READY_SCREEN]);
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome.status).toBe('answered');
    expect(port.keys).toEqual([FIRST_RUN_DISMISS_KEY]);
  });

  it('reports a clear pane without pressing anything', async () => {
    const port = scriptedPort([READY_SCREEN]);
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome.status).toBe('clear');
    expect(port.keys).toEqual([]);
  });

  it('refuses to answer the trust dialog and reports it stuck', async () => {
    const port = scriptedPort([TRUST_SCREEN]);
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome).toMatchObject({ status: 'stuck', reason: 'trust' });
    expect(port.keys).toEqual([]);
  });

  it('reports the selected-model error without pressing anything (F15)', async () => {
    const port = scriptedPort([MODEL_ERROR_SCREEN]);
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome).toMatchObject({ status: 'stuck', reason: 'model', model: 'glm-5.3' });
    expect(port.keys).toEqual([]);
  });

  it('gives up and reports stuck when the screen survives every dismissal', async () => {
    const port = scriptedPort([UPSELL_SCREEN]);
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome).toMatchObject({ status: 'stuck', reason: 'unanswered' });
    expect(port.keys.length).toBeGreaterThan(0);
  });

  it('reports stuck when the keystroke cannot be delivered', async () => {
    const port: FirstRunPort = {
      readScreen: async () => UPSELL_SCREEN,
      sendKey: async () => {
        throw new Error('daemon not connected');
      },
    };
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome).toMatchObject({ status: 'stuck', reason: 'send-failed' });
  });

  it('keeps watching through unreadable viewports', async () => {
    const readScreen = vi
      .fn(async (): Promise<string> => READY_SCREEN)
      .mockRejectedValueOnce(new Error('read timeout'));
    const port: FirstRunPort = {
      readScreen,
      sendKey: async (): Promise<void> => { /* never called here */ },
    };
    const outcome = await clearFirstRunPrompts('pty-1', port, { ...fastOptions, now: undefined });
    expect(outcome.status).toBe('clear');
    expect(readScreen.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('watchFolderTrust', () => {
  /** The composer Gemini CLI draws once it takes a prompt. */
  const COMPOSER = [' >   Type your message or @path/to/file', ' workspace (/directory)'].join('\n');
  /** A clock that moves only when the watch sleeps. */
  const clocked = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; }, log: () => undefined };
  };

  it('keeps reading past calm screens and reports a dialog drawn late, pressing nothing', async () => {
    // Blank for about 9 s at the 500 ms poll, then the dialog.
    const port = scriptedPort([...Array<string>(18).fill('starting…'), folderTrust('gemini-folder-trust-60x30')]);
    const outcome = await watchFolderTrust('pty-1', port, clocked());
    expect(outcome).toEqual({ status: 'stuck', headline: 'folder trust dialog', reason: 'trust' });
    expect(port.keys).toEqual([]);
  });

  it('ends clear once the composer shows, or at the deadline', async () => {
    expect(await watchFolderTrust('pty-1', scriptedPort(['starting…', COMPOSER]), clocked())).toEqual({ status: 'clear' });
    const calm = scriptedPort(['starting…']);
    expect(await watchFolderTrust('pty-1', calm, clocked())).toEqual({ status: 'clear' });
    expect(calm.keys).toEqual([]);
  });

  it('reads for two minutes, slower after the first 30 s: a dialog drawn at 35 s is reported', async () => {
    const clock = clocked();
    const reads: number[] = [];
    const port: FirstRunPort = {
      readScreen: async () => {
        reads.push(clock.now());
        return clock.now() >= 35_000 ? folderTrust('qwen-folder-trust-60x30') : 'starting…';
      },
      sendKey: async () => undefined,
    };
    expect(await watchFolderTrust('pty-1', port, clock)).toMatchObject({ status: 'stuck', reason: 'trust' });
    expect(reads.filter((t) => t < 30_000)).toHaveLength(60);
    expect(reads.at(-1)).toBeLessThanOrEqual(36_000);
    // With nothing drawn at all, the watch gives up at its own deadline.
    const quiet = clocked();
    expect(await watchFolderTrust('pty-1', scriptedPort(['starting…']), quiet)).toEqual({ status: 'clear' });
    expect(quiet.now()).toBeGreaterThanOrEqual(120_000);
  });

  it('finds the composer inside a narrow box', async () => {
    const boxed = ['│ >   Type your message    │', '│ or @path/to/file         │', '╰──────────────────────────╯'].join('\n');
    expect(await watchFolderTrust('pty-1', scriptedPort(['starting…', boxed]), clocked())).toEqual({ status: 'clear' });
  });

  it('a model error on the same screen does not hide the dialog', async () => {
    // Both within the model error's six-row tail: the error is read first.
    const both = [
      "There's an issue with the selected model (glm-5.3)",
      '   │ Do you trust this folder?',
      '   │ › 1. Trust folder (proj)',
      '   │   2. Trust parent folder (work)',
      "   │   3. Don't trust (esc)",
      '   ╰──────────────────────────',
    ].join('\n');
    expect(detectFirstRunPrompt(both)?.kind).toBe('model-error');
    expect(await watchFolderTrust('pty-1', scriptedPort([both]), clocked())).toMatchObject({ status: 'stuck', reason: 'trust' });
  });
});
