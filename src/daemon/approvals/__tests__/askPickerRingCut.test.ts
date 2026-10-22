// A picker read from a ring that starts mid-session (live capture on Claude
// Code 2.1.308, fixtures/terminal-prompts/claude-2.1.308/claude-ask-ring-cut-*).
// Claude repaints by cell diff and skips a cell that already holds the right
// character, so a cell last written before the ring's oldest byte cannot be
// replayed. It read as a blank: an option description holding ` | ` under a
// status line that had drawn `|` in the same cell read without its `|`, and
// every phone answer to that question came back `409 prompt-changed`
// (picker-differs). Now such a cell reads as unknown, and only an unknown
// cell is a wildcard when the picker is matched to the form.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateTextSnapshot } from '../../HeadlessSnapshot';
import { renderPaneScreen, type AwaitingFrame, type RenderablePane } from '../../AwaitingScreenVerifier';
import { UNKNOWN_CELL, withUnknownCells } from '../../sessionTextReplay';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER } from '../types';
import { claudeQuestionsForm, extractAskUserQuestion } from '../askUserQuestion';
import { askPickerUntouchedRead, askScreenMeets, parseAskPicker } from '../askPicker';

const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.308', 'claude-ask-ring-cut-01-pipe-lost-100x30-2.1.308.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cols: number; rows: number; replayBase64: string };
const STREAM = Buffer.from(fixture.replayBase64, 'base64');

const QUESTION = {
  question: '영상 제목과 썸네일 조합을 골라 주세요. 어느 쪽으로 갈까요?',
  header: '제목·썸네일',
  multiSelect: false,
  options: [
    { label: 'A안 (추천)', description: '제목 "AI 시대 신입은 어디서 시작하나 | 맨파워 CEO가 면접에서 묻는다는 질문" + 썸네일 A(프라이징, "채용 면접에서 / 이걸 묻는다 / AI 쓰다 언제 실망했나")' },
    { label: 'B안', description: '제목 "신입 일자리, AI가 줄였나 경기가 줄였나 | JP모건·맨파워·코그니전트 CEO의 답" + 썸네일 B(다이먼, "AI 시대 신입은 / 어디서 / 시작하나")' },
  ],
};
const payload = (q: unknown) => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] } });
const questionsOf = (q: unknown) => claudeQuestionsForm(payload(q))!.questions!;

/** A pane whose ring holds `stream` after `dropped` bytes it no longer has. */
function pane(stream: Buffer, dropped: number): RenderablePane {
  return {
    meta: { cols: fixture.cols, rows: fixture.rows },
    ptyProcess: { cols: fixture.cols, rows: fixture.rows },
    ringBuffer: { readAllWithGeometry: () => ({ data: stream, geometry: undefined, writtenAt: dropped + stream.length }) },
    bridge: { isMuted: false, outputModes: null },
  };
}
const render = async (p: RenderablePane): Promise<AwaitingFrame> => (await renderPaneScreen(() => p, generateTextSnapshot))!;

describe('a pane read from a ring that dropped its oldest bytes', () => {
  it('marks the cells nothing in the ring wrote, and every other reader still sees blanks', async () => {
    const frame = await render(pane(STREAM, 1_000_000));
    expect(frame.unknown).toBeDefined();
    // Option 1's `|` is one of them: blank in the rows, unknown in the mask.
    expect(frame.rows.some((r) => r.includes('어디서 시작하나   맨파워'))).toBe(true);
    expect(frame.unknown!.some((r) => r.includes(`어디서 시작하나${UNKNOWN_CELL}`))).toBe(true);
    expect(frame.rows.some((r) => r.includes(UNKNOWN_CELL))).toBe(false);
    expect(frame.rows.every((r) => r === r.replace(/ +$/, ''))).toBe(true);
  });

  it('a ring with no dropped bytes gets no fill and no mask', async () => {
    const read = { raw: STREAM, replay: STREAM, geometry: undefined, writtenAt: STREAM.length };
    expect(withUnknownCells(read, { cols: fixture.cols, rows: fixture.rows })).toEqual({ replay: STREAM, geometry: undefined, marked: false });
    const frame = await render(pane(STREAM, 0));
    expect(frame.unknown).toBeUndefined();
    expect(frame.rows.some((r) => r.includes(UNKNOWN_CELL))).toBe(false);
  });

  it('the picker matches the form with only its unknown cells as wildcards', async () => {
    const frame = await render(pane(STREAM, 1_000_000));
    const picker = parseAskPicker(frame.rows);
    const read = (q: unknown, keys: string[] = ['1']) => askPickerUntouchedRead(picker, questionsOf(q), frame.unknown, [{ keys }]);
    expect(read(QUESTION)).toBe('meets');
    expect(read(QUESTION, ['2'])).toBe('meets');
    // Without the mask the same rows are another picker (the refusal it replaces).
    expect(askPickerUntouchedRead(picker, questionsOf(QUESTION), undefined, [{ keys: ['1'] }])).toBe('differs');
    const withDescription = (j: number, description: string) => ({
      ...QUESTION,
      options: QUESTION.options.map((o, k) => (k === j ? { ...o, description } : o)),
    });
    const first = QUESTION.options[0]!.description;
    // A known character changed, added or dropped is still another picker,
    // whatever it does to the meaning.
    expect(read(withDescription(0, first.replace('맨파워 CEO가', '맨파월 CEO가')))).toBe('differs');
    expect(read(withDescription(0, first.replace('면접에서 묻는다는', '면접에서 안 묻는다는')))).toBe('differs');
    expect(read(withDescription(0, first.replace('묻는다는 질문', '질문')))).toBe('differs');
    // An unknown cell stands for one cell, not for more text than fits there.
    expect(read(withDescription(0, first.replace('시작하나 | 맨파워', '시작하나 | 그리고 | 맨파워')))).toBe('differs');
    expect(read({ ...QUESTION, question: QUESTION.question.replace('어느 쪽으로', '어느 쪽으로도') })).toBe('differs');
  });

  it('an unknown cell in the label of the option the answer chooses is unreadable, not a match', async () => {
    const frame = await render(pane(STREAM, 1_000_000));
    const row = frame.unknown!.findIndex((r) => r.includes('1. A안 (추천)'));
    // `추` takes two cells, both unseen.
    const unknown = frame.unknown!.map((r, i) => (i === row ? r.replace('A안 (추천)', `A안 (${UNKNOWN_CELL}${UNKNOWN_CELL}천)`) : r));
    const rows = unknown.map((r) => r.split(UNKNOWN_CELL).join(' ').replace(/ +$/, ''));
    const picker = parseAskPicker(rows);
    expect(askPickerUntouchedRead(picker, questionsOf(QUESTION), unknown, [{ keys: ['1'] }])).toBe('unknown');
    // Choosing the other option, the label it sends a key for is whole.
    expect(askPickerUntouchedRead(picker, questionsOf(QUESTION), unknown, [{ keys: ['2'] }])).toBe('meets');
  });
});

describe('a question read through unknown cells', () => {
  // Two questions that differ only at the end, with the same header and options.
  const form = claudeQuestionsForm({
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: ['Approve?', 'Approved?'].map((question) => ({
        question, header: 'Deploy', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }],
      })),
    },
  })!.questions!;
  const RULE = '─'.repeat(60);
  const screen = (bar: string, question: string) => [
    RULE, bar, '', question, '', '❯ 1. Yes', '  2. No', '  3. Type something.', RULE, '  4. Chat about this', '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ];
  const UNTOUCHED = '←  ☐ Deploy  ☐ Deploy  ✔ Submit  →';
  const plain = (rows: string[]) => rows.map((r) => r.split(UNKNOWN_CELL).join(' ').replace(/ +$/, ''));

  it('is the question only when it reads as no other question of the form', () => {
    // Seen whole, `Approve?` is the first question and never the second.
    const whole = screen(UNTOUCHED, 'Approve?');
    expect(askPickerUntouchedRead(parseAskPicker(whole), form, undefined, [])).toBe('meets');
    const second = screen('←  ☒ Deploy  ☐ Deploy  ✔ Submit  →', 'Approve?');
    expect(askScreenMeets(parseAskPicker(second), { view: 'question', q: 1, cursor: '1', checked: [], other: null }, form, [])).toBe(false);
    // Two unseen cells after `Approve` could be `?` or `d?`: no key is sent.
    const unknown = screen(UNTOUCHED, `Approve${UNKNOWN_CELL}${UNKNOWN_CELL}`);
    expect(askPickerUntouchedRead(parseAskPicker(plain(unknown)), form, unknown, [])).toBe('unknown');
    // With one unseen cell only `Approve?` fits.
    const one = screen(UNTOUCHED, `Approve${UNKNOWN_CELL}`);
    expect(askPickerUntouchedRead(parseAskPicker(plain(one)), form, one, [])).toBe('meets');
  });
});

// ── Through the registry ────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ring-cut-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('a phone answer to that picker', () => {
  it('sends the key instead of refusing the picker as changed', async () => {
    const frame = await render(pane(STREAM, 1_000_000));
    const stepKeys: string[] = [];
    const clock = { now: 10_000 };
    const mark = { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' };
    let next = 1;
    const registry = new ApprovalRegistry({
      wmuxDir: tmpDir,
      readScreenTail: async () => [...frame.rows],
      writeToSession: () => true,
      writeStepKey: (_id, data) => {
        stepKeys.push(data);
        mark.keyInputRevision += 1;
        return mark.keyInputRevision;
      },
      readPromptScreen: async () => ({ rows: frame.rows, mark: { ...mark }, cols: fixture.cols, unknown: frame.unknown }),
      promptScreenMark: () => ({ ...mark }),
      pendingToolUse: () => null,
      promptReadDelay: async (ms) => { clock.now += ms; },
      schedule: () => () => undefined,
      now: () => clock.now,
      newId: () => `req-${next++}`,
    });
    const asked = extractAskUserQuestion(payload(QUESTION));
    await registry.noteHookAwaitingInput({
      sessionId: 'pty-a',
      agent: 'claude',
      workspaceId: 'ws-1',
      ...(asked.question ? { question: asked.question } : {}),
      ...(asked.options ? { options: asked.options } : {}),
      form: claudeQuestionsForm(payload(QUESTION))!,
    });
    const [record] = registry.list().pending;
    clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    const result = await registry.resolve({
      id: record!.id,
      decision: 'approve',
      resolvedBy: 'device Test phone (dev-1)',
      decisionV2Answer: DECISION_V2_WEB_ANSWER,
      decisionAnswer: { formFingerprint: record!.formFingerprint!, clientAnswerId: 'answer-00000000001', answers: [{ questionId: 'q0', keys: ['1'] }] },
    });
    expect(result).not.toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(stepKeys).toEqual(['1']);
  });
});
