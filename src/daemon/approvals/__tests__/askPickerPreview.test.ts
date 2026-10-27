// Claude's AskUserQuestion picker when its options carry a `preview` (live
// captures on Claude Code 2.1.311, fixtures/terminal-prompts/claude-2.1.311/
// claude-ask-preview-*): a single-select question is drawn side by side, the
// labels on the left and the focused option's preview boxed on the right. The
// parse read every row whole, so the box's `│` rows ran into the last option
// and there was no "Type something" row: every phone answer to such a question
// came back `409 prompt-changed` ("picker-unreadable"). There a digit only
// moves the cursor and Enter selects, so the driver types the digit, then Enter.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER, type ApprovalRequest } from '../types';
import { claudeQuestionsForm, extractAskUserQuestion } from '../askUserQuestion';
import { UNKNOWN_CELL } from '../../sessionTextReplay';
import {
  ASK_KEY_DOWN,
  ASK_KEY_ENTER,
  answersConfirmed,
  askAnswerSteps,
  askConfirmBaseline,
  askPickerOnScreen,
  askPickerUntouched,
  askScreenMeets,
  parseAskPicker,
} from '../askPicker';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.311');
const fixture = (name: string): { cols: number; screen: string[] } =>
  JSON.parse(fs.readFileSync(path.join(DIR, `claude-ask-preview-${name}.json`), 'utf8')) as { cols: number; screen: string[] };
const screen = (name: string): string[] => fixture(name).screen;

const ONE = {
  initial: screen('01-initial-57x40-2.1.311'),
  digit2: screen('02-after-digit2-57x40-2.1.311'),
  answered: screen('03-answered-57x40-2.1.311'),
};
const WRAP = {
  initial: screen('wrap-01-initial-57x40-2.1.311'),
  down: screen('wrap-02-after-down-57x40-2.1.311'),
  narrow: screen('narrow-01-initial-40x40-2.1.311'),
};
const TWO = {
  initial: screen('two-01-initial-57x40-2.1.311'),
  digit2: screen('two-02-after-digit2-57x40-2.1.311'),
  enter: screen('two-03-after-enter-57x40-2.1.311'),
  review: screen('two-04-review-57x40-2.1.311'),
  answered: screen('two-05-answered-57x40-2.1.311'),
  noPreview: screen('two-06-no-preview-57x40-2.1.311'),
};
/** Synthetic: the shape a phone-sized 57-column pane logged, box from column 31. */
const SYNTHETIC = screen('synthetic-01-divider31-57x38');

const payload = (questions: unknown[]) => ({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });
const questionsOf = (p: unknown) => claudeQuestionsForm(p)!.questions!;

const ONE_Q = {
  question: '회의실 예약 화면의 날짜 선택기를 어떤 방식으로 바꿀까요? 모바일에서 두 손가락 없이도 쓸 수 있어야 합니다.',
  header: '선택기',
  multiSelect: false,
  options: [
    { label: '달력 그리드', description: '한 달을 한 화면에 보여 주고 날짜를 눌러 고르면 바로 닫히는 방식으로 바꾼다', preview: '<Calendar\n  month={m}\n  onPick={close}\n/>' },
    { label: '목록 스크롤', description: '가까운 날짜부터 세로 목록으로 보여 준다', preview: '<DateList\n  from={today}\n  days={30}\n/>' },
    { label: '지금 유지', description: '현재 입력 칸을 그대로 둔다', preview: '<input\n  type="date"\n/>' },
  ],
};
const WRAP_Q = {
  question: '알림 설정 화면을 어떻게 정리할까요?',
  header: '알림',
  multiSelect: false,
  options: [
    { label: '알림을 종류별 묶음으로 나누어 보여 주기 (Recommended)', description: '메일, 일정, 댓글 알림을 각각 접었다 펼 수 있는 묶음으로 나누고 묶음마다 한 번에 끄는 스위치를 둔다', preview: '## 묶음 보기' },
    { label: '시간대별 방해 금지만 추가', description: '지금 화면은 그대로 두고 밤 시간대에 알림을 멈추는 칸 하나만 더한다', preview: 'quiet_hours:' },
    { label: '검색 칸 넣기', description: '설정이 많으니 맨 위에 검색 칸을 둔다', preview: '검색 칸 하나' },
    { label: '지금 유지', description: '바꾸지 않는다', preview: '변경 없음' },
  ],
};
const TWO_QS = [
  {
    question: '목록 정렬 기준을 무엇으로 할까요?',
    header: '정렬',
    multiSelect: false,
    options: [
      { label: '이름순', description: '가나다 순서로 정렬한다', preview: 'sort(by: name)' },
      { label: '최근 수정순', description: '마지막으로 고친 항목이 위로 온다', preview: 'sort(by: updatedAt)\n  .reverse()' },
      { label: '직접 정하기', description: '끌어서 순서를 바꾼다' },
    ],
  },
  {
    question: '빈 목록일 때 무엇을 보여 줄까요?',
    header: '빈 화면',
    multiSelect: false,
    options: [
      { label: '안내 문구', description: '짧은 문장 하나' },
      { label: '그림과 버튼', description: '그림 아래에 새로 만들기 버튼' },
    ],
  },
];
const SYNTHETIC_Q = {
  question: '파일 업로드 중에 보여 줄 진행 표시를 어떤 방식으로 바꿀까요? 작은 화면에서도 한눈에 보여야 합니다.',
  header: '진행 표시',
  multiSelect: false,
  options: [
    { label: '진행 막대를 버튼 위에 겹쳐 보여 주기 (Recommended)', description: '막대가 버튼을 덮고, 끝나면 사라진다', preview: '<UploadProgress />' },
    { label: '남은 시간을 숫자로만 표시', description: '막대 없이 남은 초만 적는다', preview: '<Remaining />' },
    { label: '지금 유지', description: '바꾸지 않는다', preview: '<Spinner />' },
  ],
};
const noPreview = (q: typeof ONE_Q) => ({ ...q, options: q.options.map(({ label, description }) => ({ label, description })) });

describe('the form of a question whose options carry a preview', () => {
  it('a single-select one is marked preview and takes no free text', () => {
    const [q] = questionsOf(payload([ONE_Q]));
    expect(q).toMatchObject({ preview: true, allowOther: false, multiSelect: false });
    // One option with a preview is enough: Claude draws the whole question side by side.
    const [, ...rest] = ONE_Q.options;
    expect(questionsOf(payload([{ ...ONE_Q, options: [{ label: 'a', description: 'b' }, ...rest] }]))[0]).toMatchObject({ preview: true });
  });

  it('a multi-select one, or one without previews, is drawn as usual', () => {
    expect(questionsOf(payload([{ ...ONE_Q, multiSelect: true }]))[0]).toMatchObject({ allowOther: true });
    expect(questionsOf(payload([{ ...ONE_Q, multiSelect: true }]))[0]).not.toHaveProperty('preview');
    expect(questionsOf(payload([noPreview(ONE_Q)]))[0]).not.toHaveProperty('preview');
    expect(questionsOf(payload(TWO_QS)).map((q) => q.preview === true)).toEqual([true, false]);
  });
});

describe('the side-by-side preview picker', () => {
  it('reads the left column only: the labels and the cursor, none of the preview', () => {
    const picker = parseAskPicker(ONE.initial);
    expect(picker).toMatchObject({
      view: 'question',
      preview: true,
      question: ONE_Q.question,
      options: [
        { key: '1', label: '달력 그리드', cursor: true },
        { key: '2', label: '목록 스크롤', cursor: false },
        { key: '3', label: '지금 유지', cursor: false },
      ],
    });
    expect(picker!.view === 'question' && picker!.options.every((o) => !o.more)).toBe(true);
    expect(askPickerUntouched(picker, questionsOf(payload([ONE_Q])))).toBe(true);
  });

  it('reads Korean labels that wrap in the left column, at 57 and at 40 columns', () => {
    const qs = questionsOf(payload([WRAP_Q]));
    expect(parseAskPicker(WRAP.initial)).toMatchObject({
      preview: true,
      options: [
        { label: '알림을 종류별 묶음으로', more: ['나누어 보여 주기', '(Recommended)'], cursor: true },
        { label: '시간대별 방해 금지만', more: ['추가'] },
        { label: '검색 칸 넣기' },
        { label: '지금 유지' },
      ],
    });
    expect(parseAskPicker(WRAP.narrow)).toMatchObject({
      preview: true,
      options: [
        { label: '알림을 종류별', more: ['묶음으로 나누어', '보여 주기', '(Recommended)'] },
        { label: '시간대별 방해', more: ['금지만 추가'] },
        { label: '검색 칸 넣기' },
        { label: '지금 유지' },
      ],
    });
    for (const rows of [WRAP.initial, WRAP.narrow]) expect(askPickerUntouched(parseAskPicker(rows), qs)).toBe(true);
    // The Notes row beside option 4 (option 2's shorter preview) stays out of its label.
    expect(askScreenMeets(parseAskPicker(WRAP.down), { view: 'question', q: 0, cursor: '2', checked: [], other: null }, qs, [{ keys: ['2'] }])).toBe(true);
  });

  it('reads the shape the phone-sized pane logged (57 columns, the box from column 31)', () => {
    const picker = parseAskPicker(SYNTHETIC);
    expect(picker).toMatchObject({ view: 'question', preview: true, options: [{ cursor: true }, {}, {}] });
    expect(askPickerUntouched(picker, questionsOf(payload([SYNTHETIC_Q])))).toBe(true);
  });

  it('matches labels only: a description is not drawn, but another label is another option', () => {
    expect(askPickerUntouched(parseAskPicker(ONE.initial), questionsOf(payload([{ ...ONE_Q, options: ONE_Q.options.map((o) => ({ ...o, description: 'x' })) }])))).toBe(true);
    const renamed = { ...ONE_Q, options: ONE_Q.options.map((o, j) => (j === 1 ? { ...o, label: '목록 스크롤 보기' } : o)) };
    expect(askPickerUntouched(parseAskPicker(ONE.initial), questionsOf(payload([renamed])))).toBe(false);
  });

  it('the layout must be the one the form says: a preview screen for a plain form, or the reverse, is refused', () => {
    expect(askPickerUntouched(parseAskPicker(ONE.initial), questionsOf(payload([noPreview(ONE_Q)])))).toBe(false);
    const plain = ONE.initial.map((row) => row.replace(/ +[┌│└].*$/, '')).filter((row) => !/^ +(Notes|notes)/.test(row));
    expect(askPickerUntouched(parseAskPicker(plain), questionsOf(payload([ONE_Q])))).toBe(false);
  });

  it('still refuses a row that does not split at the box column', () => {
    // A wide character across the column (columns 30 and 31).
    const straddle = SYNTHETIC.map((row) => row.replace(/^ {2}3\. 지금 유지 +│/, `  3. ${'가'.repeat(12)}x나│`));
    expect(straddle).not.toEqual(SYNTHETIC);
    expect(parseAskPicker(straddle)).toBeNull();
    // Text running into the box with no blank between.
    const glued = SYNTHETIC.map((row) => row.replace(/^( {4}\(Recommended\)) +│/, (_m, l: string) => `${l}${'x'.repeat(31 - l.length)}│`));
    expect(glued).not.toEqual(SYNTHETIC);
    expect(parseAskPicker(glued)).toBeNull();
    // Still known to be a picker up, so the record is not retired.
    expect(askPickerOnScreen(glued)).toBe(true);
  });

  it('reads through unknown cells in the blank between a label and the box', () => {
    const qs = questionsOf(payload([ONE_Q]));
    const unknown = ONE.initial.map((row) => (/^(❯| ) \d\. /.test(row) ? row.replace(/ {2,}(?=┌|│)/, (gap) => UNKNOWN_CELL.repeat(gap.length)) : row));
    expect(unknown).not.toEqual(ONE.initial);
    expect(askPickerUntouched(parseAskPicker(ONE.initial), qs, unknown)).toBe(true);
  });

  it('finds the box after a label that holds a ┌ itself', () => {
    const boxed = ONE.initial.map((row) => row.replace('1. 달력 그리드  ', '1. 달력 ┌ 그리드'));
    expect(boxed).not.toEqual(ONE.initial);
    const options = ONE_Q.options.map((o, j) => (j === 0 ? { ...o, label: '달력 ┌ 그리드' } : o));
    expect(askPickerUntouched(parseAskPicker(boxed), questionsOf(payload([{ ...ONE_Q, options }])))).toBe(true);
  });

  it('follows the cursor onto an option without a preview', () => {
    const qs = questionsOf(payload(TWO_QS));
    expect(askScreenMeets(parseAskPicker(TWO.noPreview), { view: 'question', q: 0, cursor: '3', checked: [], other: null }, qs, [{ keys: ['3'] }, { keys: ['1'] }])).toBe(true);
  });
});

describe('the keys of a preview answer', () => {
  it('a digit moves the cursor, then Enter selects; option 1 takes Enter alone', () => {
    const one = questionsOf(payload([ONE_Q]));
    expect(askAnswerSteps(one, [{ keys: ['2'] }])).toEqual([
      { key: '2', expect: { view: 'question', q: 0, cursor: '2', checked: [], other: null } },
      { key: ASK_KEY_ENTER, expect: { view: 'closed' } },
    ]);
    expect(askAnswerSteps(one, [{ keys: ['1'] }]).map((s) => s.key)).toEqual([ASK_KEY_ENTER]);
    expect(askAnswerSteps(questionsOf(payload(TWO_QS)), [{ keys: ['2'] }, { keys: ['1'] }]).map((s) => s.key)).toEqual(['2', ASK_KEY_ENTER, '1', '1']);
    expect(ASK_KEY_DOWN).not.toBe(ASK_KEY_ENTER);
  });

  it('each measured screen meets what its key should have drawn', () => {
    const qs = questionsOf(payload(TWO_QS));
    const answers = [{ keys: ['2'] }, { keys: ['1'] }];
    const steps = askAnswerSteps(qs, answers);
    expect(askScreenMeets(parseAskPicker(TWO.digit2), steps[0]!.expect, qs, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(TWO.enter), steps[1]!.expect, qs, answers)).toBe(true);
    expect(askScreenMeets(parseAskPicker(TWO.review), steps[2]!.expect, qs, answers)).toBe(true);
    expect(answersConfirmed(TWO.answered, askConfirmBaseline(TWO.initial), qs, answers)).toBe(true);
    // The digit alone selected nothing: the screen after it is not the next question.
    expect(askScreenMeets(parseAskPicker(TWO.digit2), steps[1]!.expect, qs, answers)).toBe(false);
  });
});

// ── Through the registry ────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ask-preview-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** A pane whose screen after the n-th key is `frames[n]` (the last frame stays). */
function makeRegistry(initial: readonly string[], frames: ReadonlyArray<readonly string[]>, cols = 57) {
  const pane = { rows: initial, bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', cols };
  const stepKeys: string[] = [];
  const clock = { now: 10_000 };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => [...pane.rows],
    writeToSession: () => true,
    writeStepKey: (_id, data) => {
      stepKeys.push(data);
      pane.keyInputRevision += 1;
      pane.bytes += 50;
      pane.rows = frames[Math.min(stepKeys.length, frames.length) - 1] ?? pane.rows;
      return pane.keyInputRevision;
    },
    noteSubmitted: () => undefined,
    readPromptScreen: async () => ({ rows: pane.rows, mark: { bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }, cols: pane.cols }),
    promptScreenMark: () => ({ bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }),
    pendingToolUse: () => null,
    promptReadDelay: async (ms) => { clock.now += ms; },
    schedule: () => () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, stepKeys, clock };
}

async function create(h: ReturnType<typeof makeRegistry>, p: unknown): Promise<ApprovalRequest> {
  const asked = extractAskUserQuestion(p);
  await h.registry.noteHookAwaitingInput({
    sessionId: 'pty-a',
    agent: 'claude',
    ...(asked.question ? { question: asked.question } : {}),
    ...(asked.options ? { options: asked.options } : {}),
    ...(asked.choices ? { choices: asked.choices } : {}),
    form: claudeQuestionsForm(p)!,
  });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

const answer = (h: ReturnType<typeof makeRegistry>, record: ApprovalRequest, answers: Array<{ questionId: string; keys: string[]; other?: string }>) =>
  h.registry.resolve({
    id: record.id,
    decision: 'approve',
    resolvedBy: 'device Test phone (dev-1)',
    decisionV2Answer: DECISION_V2_WEB_ANSWER,
    decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'answer-00000000001', answers },
  });

describe('a phone answer to a preview question', () => {
  it('one question: the digit, then Enter, confirmed on screen, resolved', async () => {
    const h = makeRegistry(ONE.initial, [ONE.digit2, ONE.answered]);
    const record = await create(h, payload([ONE_Q]));
    expect(await answer(h, record, [{ questionId: 'q0', keys: ['2'] }])).toMatchObject({ ok: true });
    expect(h.stepKeys).toEqual(['2', ASK_KEY_ENTER]);
    expect(h.registry.list().pending).toEqual([]);
  });

  it('two questions, the first side by side: digit, Enter, the second as usual, then the review', async () => {
    const h = makeRegistry(TWO.initial, [TWO.digit2, TWO.enter, TWO.review, TWO.answered]);
    const record = await create(h, payload(TWO_QS));
    expect(await answer(h, record, [{ questionId: 'q0', keys: ['2'] }, { questionId: 'q1', keys: ['1'] }])).toMatchObject({ ok: true });
    expect(h.stepKeys).toEqual(['2', ASK_KEY_ENTER, '1', '1']);
  });

  it('the shape the phone-sized pane logged: option 1 is Enter alone', async () => {
    const answered = [
      ...SYNTHETIC.slice(0, 10),
      '⏺ User answered Claude\'s questions:',
      `  ⎿  · ${SYNTHETIC_Q.question} → ${SYNTHETIC_Q.options[0]!.label}`,
      ...Array.from({ length: 26 }, () => ''),
    ];
    const h = makeRegistry(SYNTHETIC, [answered]);
    const record = await create(h, payload([SYNTHETIC_Q]));
    expect(await answer(h, record, [{ questionId: 'q0', keys: ['1'] }])).toMatchObject({ ok: true });
    expect(h.stepKeys).toEqual([ASK_KEY_ENTER]);
  });

  it('free text is refused before anything is typed: the layout has no row for it', async () => {
    const h = makeRegistry(ONE.initial, []);
    const record = await create(h, payload([ONE_Q]));
    expect(await answer(h, record, [{ questionId: 'q0', keys: [], other: 'something else' }])).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.stepKeys).toEqual([]);
  });

  it('a preview picker the read cannot split is refused as before, nothing typed, the record kept', async () => {
    const glued = SYNTHETIC.map((row) => row.replace(/^( {4}\(Recommended\)) +│/, (_m, l: string) => `${l}${'x'.repeat(31 - l.length)}│`));
    const h = makeRegistry(glued, []);
    const record = await create(h, payload([SYNTHETIC_Q]));
    expect(await answer(h, record, [{ questionId: 'q0', keys: ['1'] }])).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.stepKeys).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });
});
