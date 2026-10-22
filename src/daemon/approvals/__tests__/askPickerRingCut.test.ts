// A picker read from a ring that starts mid-session (live capture on Claude
// Code 2.1.308, fixtures/terminal-prompts/claude-2.1.308/claude-ask-ring-cut-*).
// Claude repaints by cell diff and skips a cell that already holds the right
// character, so a character whose cell was written before the ring's oldest
// byte replays blank. An option description holding ` | ` under a status line
// that had drawn `|` in the same cell read without its `|`, and every phone
// answer to that question came back `409 prompt-changed` (picker-differs).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateTextSnapshot } from '../../HeadlessSnapshot';
import { claudeQuestionsForm } from '../askUserQuestion';
import { askPickerUntouched, parseAskPicker } from '../askPicker';

const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.308', 'claude-ask-ring-cut-01-pipe-lost-100x30-2.1.308.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cols: number; rows: number; replayBase64: string };

const QUESTION = {
  question: '영상 제목과 썸네일 조합을 골라 주세요. 어느 쪽으로 갈까요?',
  header: '제목·썸네일',
  multiSelect: false,
  options: [
    { label: 'A안 (추천)', description: '제목 "AI 시대 신입은 어디서 시작하나 | 맨파워 CEO가 면접에서 묻는다는 질문" + 썸네일 A(프라이징, "채용 면접에서 / 이걸 묻는다 / AI 쓰다 언제 실망했나")' },
    { label: 'B안', description: '제목 "신입 일자리, AI가 줄였나 경기가 줄였나 | JP모건·맨파워·코그니전트 CEO의 답" + 썸네일 B(다이먼, "AI 시대 신입은 / 어디서 / 시작하나")' },
  ],
};
const questionsOf = (q: unknown) => claudeQuestionsForm({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [q] } })!.questions!;

/** The rows the daemon reads: the cut stream through its headless terminal. */
async function replayed(): Promise<string[]> {
  const out = await generateTextSnapshot({ cols: fixture.cols, rows: fixture.rows, scrollback: 0, initial: Buffer.from(fixture.replayBase64, 'base64') });
  if (!out.ok) throw new Error(out.reason);
  return out.rows.map((r) => r.text);
}

describe('a picker replayed from a ring that starts mid-session', () => {
  it('reads with the `|` it never redrew lost, and is still the untouched picker', async () => {
    const rows = await replayed();
    // Option 1's wrapped description, its `|` gone; option 2's kept.
    expect(rows.some((r) => r.includes('어디서 시작하나   맨파워'))).toBe(true);
    expect(rows.some((r) => r.includes('줄였나 | JP모건'))).toBe(true);
    const picker = parseAskPicker(rows);
    expect(picker).toMatchObject({ view: 'question', tabs: [{ label: '제목·썸네일', answered: false }] });
    expect(askPickerUntouched(picker, questionsOf(QUESTION))).toBe(true);
  });

  it('a character changed or added, or more lost than a read can lose, is still another picker', async () => {
    const rows = await replayed();
    const changed = (from: string, to: string) => askPickerUntouched(parseAskPicker(rows.map((r) => r.replace(from, to))), questionsOf(QUESTION));
    expect(changed('맨파워 CEO가', '맨파월 CEO가')).toBe(false);
    expect(changed('맨파워 CEO가', '맨파워 CEO가!')).toBe(false);
    expect(changed('면접에서 묻는다는 질문', '면접에서')).toBe(false);
    // The question and the header lose characters the same way.
    expect(changed('어느 쪽으로', '어느 쪽 로')).toBe(true);
    expect(changed('어느 쪽으로 갈까요?', '어느')).toBe(false);
    expect(changed('☐ 제목·썸네일', '☐ 제목 썸네일')).toBe(true);
    expect(changed('☐ 제목·썸네일', '☐ 제목·썸')).toBe(false);
  });

});
