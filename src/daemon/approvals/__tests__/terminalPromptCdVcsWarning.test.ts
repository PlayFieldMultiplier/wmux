// Claude Code 2.1.296 asks before a Bash command that changes directory and
// then runs a version-control command (`cd <dir> && git push …`), with a
// warning paragraph drawn in a gutter under the command box:
//
//    Bash command
//    Dry-run push of main to origin from sub directory
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    cd sub && git push --dry-run origin main
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    │ This command changes directory before running a version-control command, which can pick up
//    │ untrusted hooks or repository configuration from the target directory. Approve only if you trust
//    │ it.
//    Permission rule Bash(git push *) requires confirmation for this command.
//    /permissions to update rules
//
// The paragraph makes the dialog three rows taller, so in a short pane its
// top rule scrolls off while the "Bash command" title is still the first row.
// The short command is boxed without a gutter, and a top-cut box was only read
// when every row in it was a gutter row: the parser fell back to the unboxed
// layout, took the paragraph for the title, and the record never bound. The
// screens below are live captures (fixtures/terminal-prompts/claude-2.1.296/);
// the transcript had no tool_use while the dialog was up, so the record binds
// by the PermissionRequest hook alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalRequest } from '../types';
import { dialogMatchesToolCall, parseTerminalPrompt, terminalPromptAnswerability } from '../terminalPromptParse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.296');
type Fixture = { version: string; cols: number; rows: number; screen: string[] };
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

const WHOLE = load('claude-bash-cd-vcs-01-whole-100x30-2.1.296.json');
const TITLE_FIRST = load('claude-bash-cd-vcs-02-fullscreen-100x16-2.1.296.json');
const TITLE_CUT = load('claude-bash-cd-vcs-03-fullscreen-100x14-2.1.296.json');

const COMMAND = 'cd sub && git push --dry-run origin main';
const DESCRIPTION = 'Dry-run push of main to origin from sub directory';
const CALL = { name: 'Bash', command: COMMAND, description: DESCRIPTION };
const WARNING = 'This command changes directory before running a version-control command, which can pick up '
  + 'untrusted hooks or repository configuration from the target directory. Approve only if you trust it.';

const parse = (fx: Fixture) => parseTerminalPrompt(fx.screen, { cols: fx.cols });

describe('the cd-before-version-control dialog', () => {
  it.each([
    ['whole, 100x30', WHOLE, true],
    ['top rule cut, title first, 100x16', TITLE_FIRST, false],
  ])('%s: reads the box as the command and the warning as reason prose', (_label, fx, topRuleFound) => {
    const parsed = parse(fx)!;
    expect(parsed).toMatchObject({
      title: 'Bash command',
      commandRows: [COMMAND],
      descriptionRows: [DESCRIPTION],
      question: 'Do you want to proceed?',
      topRuleFound,
      active: true,
      cut: false,
    });
    // Capped for display at 200 characters; read without the paragraph's gutter.
    expect(parsed.reason).toBe(`${`${WARNING} Permission rule`.slice(0, 200)}…`);
    expect(terminalPromptAnswerability(parsed)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
  });

  it('binds whole, and with the top cut only by the call\'s exact command, description and tool', () => {
    expect(dialogMatchesToolCall(parse(WHOLE)!, CALL)).toBe(true);
    const cut = parse(TITLE_FIRST)!;
    expect(dialogMatchesToolCall(cut, CALL)).toBe(false);
    expect(dialogMatchesToolCall(cut, CALL, { topCut: true })).toBe(true);
    expect(dialogMatchesToolCall(cut, { ...CALL, command: 'cd sub && git push origin main' }, { topCut: true })).toBe(false);
    expect(dialogMatchesToolCall(cut, { ...CALL, description: 'Push main' }, { topCut: true })).toBe(false);
    expect(dialogMatchesToolCall(cut, { ...CALL, name: 'PowerShell' }, { topCut: true })).toBe(false);
  });

  it('with the title cut off too, nothing on screen says the box holds a command: it never binds', () => {
    const parsed = parse(TITLE_CUT);
    expect(parsed?.commandRows ?? []).not.toContain(COMMAND);
    expect(parsed ? dialogMatchesToolCall(parsed, CALL, { topCut: !parsed.topRuleFound }) : false).toBe(false);
  });
});

// ── The record and the answer, through the registry ─────────────────────────

const SESSION = '965ca79d-6c75-4a87-ac96-ff2992afb63b';
/** The PermissionRequest hook's note, as HookIngest builds it from the live payload. */
const HOOK = {
  source: 'hook' as const,
  toolName: 'Bash',
  toolInput: { command: COMMAND, description: DESCRIPTION },
  hookSessionId: SESSION,
  promptId: '3581ea9e-4a78-426e-bc58-607d196dcd83',
};

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cd-vcs-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(fx: Fixture) {
  const writes: string[] = [];
  const clock = { now: 10_000 };
  const mark = { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    readPromptScreen: async () => ({ rows: fx.screen, cols: fx.cols, mark }),
    promptScreenMark: () => mark,
    // Measured: no tool_use in the transcript while the dialog is up.
    pendingToolUse: () => null,
    agentSessionId: () => SESSION,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, writes, clock };
}

async function create(h: ReturnType<typeof makeRegistry>, note: Partial<typeof HOOK> = {}): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK, ...note });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

describe('cd-before-version-control records', () => {
  it.each([
    ['whole', WHOLE],
    ['top rule cut, title first', TITLE_FIRST],
  ])('%s: answerable with the question, the clean reason and plain Yes/No; the phone presses 1', async (_label, fx) => {
    const h = makeRegistry(fx);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'Bash',
      summary: COMMAND,
      question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(record.reason).toMatch(/^This command changes directory before running a version-control command/);
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await h.registry.resolve({
      id: record.id,
      decision: 'approve',
      choiceKey: '1',
      promptFingerprint: record.promptFingerprint,
      resolvedBy: 'device Test phone (dev-1)',
      terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    })).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it.each([
    ['the hook names another command', WHOLE, { toolInput: { command: 'cd sub && git push origin main', description: DESCRIPTION } }],
    ['the hook names another command (top cut)', TITLE_FIRST, { toolInput: { command: 'cd sub && git push origin main', description: DESCRIPTION } }],
    ['the title is cut off too', TITLE_CUT, {}],
  ])('%s → informational: no choices, no fingerprint', async (_label, fx, note) => {
    const record = await create(makeRegistry(fx), note);
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
  });
});
