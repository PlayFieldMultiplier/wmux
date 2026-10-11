// Claude Code 2.1.296 draws a countdown under the reason of a dialog that
// denies itself when nobody answers (here: the dangerousRemoval safety check
// in a bypassPermissions session, a 120 s window):
//
//    │ Dangerous rm operation on possibly-empty variable path: "$ADC_TARGET"/* in `rm -r
//    │ "$ADC_TARGET"/*` (rewrite it as "${ADC_TARGET:?}"/* or use a literal path)
//    ⚠ Claude Code will automatically deny this request in 1:58, to avoid blocking progress on an
//    unattended session
//
// It is redrawn every second. Hashed with the reason it changed the dialog's
// fingerprint every second, so every phone answer came back `prompt-changed`
// and Claude then denied the call. The screens are live captures
// (fixtures/terminal-prompts/claude-2.1.296/claude-bash-auto-deny-*).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, AUTO_DENY_JITTER_MS, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalRequest } from '../types';
import { dialogMatchesToolCall, parseTerminalPrompt, terminalPromptAnswerability } from '../terminalPromptParse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.296');
type Fixture = { cols: number; rows: number; screen: string[] };
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

const WHOLE = load('claude-bash-auto-deny-01-whole-100x30-2.1.296.json');
const TICK = load('claude-bash-auto-deny-02-tick-100x30-2.1.296.json');
const NARROW_60 = load('claude-bash-auto-deny-03-narrow-60x30-2.1.296.json');
const NARROW_40 = load('claude-bash-auto-deny-04-narrow-40x30-2.1.296.json');
const FULLSCREEN = load('claude-bash-auto-deny-05-fullscreen-100x18-2.1.296.json');
const TOP_CUT = load('claude-bash-auto-deny-06-top-cut-100x14-2.1.296.json');

const COMMAND = 'rm -r "$ADC_TARGET"/*';
const DESCRIPTION = 'Remove contents of ADC_TARGET directory as instructed';
const WARNING = 'Dangerous rm operation on possibly-empty variable path: "$ADC_TARGET"/* in `rm -r "$ADC_TARGET"/*` '
  + '(rewrite it as "${ADC_TARGET:?}"/* or use a literal path)';
const COUNTDOWN = /⚠|automatically deny/;

const parse = (fx: Fixture) => parseTerminalPrompt(fx.screen, { cols: fx.cols });
/** The fixture's screen with its countdown rows replaced (`[]` takes the countdown away). */
const withCountdown = (fx: Fixture, rows: string[]): string[] => {
  const at = fx.screen.findIndex((r) => r.startsWith(' ⚠ Claude Code will automatically deny'));
  const end = fx.screen.findIndex((r, i) => i > at && r.trim() === '');
  return [...fx.screen.slice(0, at), ...rows, ...fx.screen.slice(end)];
};

describe('the auto-deny countdown on screen', () => {
  it.each([
    ['whole, 100x30', WHOLE, 118_000],
    ['three seconds later', TICK, 115_000],
    ['narrow, 60x30', NARROW_60, 113_000],
    ['narrow, 40x30 (four rows)', NARROW_40, 111_000],
    ['fullscreen, 100x18', FULLSCREEN, 118_000],
  ])('%s: read off, out of the reason, the dialog still answerable', (_label, fx, remaining) => {
    const parsed = parse(fx)!;
    expect(parsed).toMatchObject({
      title: 'Bash command',
      commandRows: [COMMAND],
      question: 'Do you want to proceed?',
      topRuleFound: true,
      active: true,
      cut: false,
      autoDenyRemainingMs: remaining,
    });
    expect(parsed.reason).toBe(WARNING);
    expect(terminalPromptAnswerability(parsed)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND })).toBe(true);
  });

  it('the fingerprint does not move with the clock, the width it wraps at, or the countdown going away', () => {
    const fp = parse(WHOLE)!.fingerprint;
    expect(parse(TICK)!.fingerprint).toBe(fp);
    expect(parse(NARROW_60)!.fingerprint).toBe(fp);
    expect(parse(NARROW_40)!.fingerprint).toBe(fp);
    // A key at the desk stops the countdown and Claude takes the row away.
    const gone = parseTerminalPrompt(withCountdown(WHOLE, []), { cols: WHOLE.cols })!;
    expect(gone.fingerprint).toBe(fp);
    expect(gone).not.toHaveProperty('autoDenyRemainingMs');
  });

  it.each([
    ['0:05', 5_000],
    ['12:00', 720_000],
  ])('reads %s as %d ms, hashed alike', (time, ms) => {
    const rows = [` ⚠ Claude Code will automatically deny this request in ${time}, to avoid blocking progress on an`, ' unattended session'];
    const parsed = parseTerminalPrompt(withCountdown(WHOLE, rows), { cols: WHOLE.cols })!;
    expect(parsed.autoDenyRemainingMs).toBe(ms);
    expect(parsed.fingerprint).toBe(parse(WHOLE)!.fingerprint);
  });

  it('the accessibility rendering ("about 2 minutes") is kept out too, with no remaining time read', () => {
    const rows = [' ⚠ Claude Code will automatically deny this request in about 2 minutes, to avoid blocking progress on', ' an unattended session'];
    const parsed = parseTerminalPrompt(withCountdown(WHOLE, rows), { cols: WHOLE.cols })!;
    expect(parsed.reason).toBe(WARNING);
    expect(parsed).not.toHaveProperty('autoDenyRemainingMs');
    expect(parsed.fingerprint).toBe(parse(WHOLE)!.fingerprint);
  });

  it('with the title scrolled off, the countdown is still left out of the reason and the hash (and nothing binds)', () => {
    const parsed = parse(TOP_CUT)!;
    // As before: the box's lower edge reads as a rule, nothing names the tool.
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND }, { topCut: !parsed.topRuleFound })).toBe(false);
    expect(`${parsed.title ?? ''} ${parsed.reason ?? ''}`).not.toMatch(COUNTDOWN);
    expect(parsed.autoDenyRemainingMs).toBe(118_000);
    const later = TOP_CUT.screen.map((r) => r.replace('in 1:58,', 'in 1:41,'));
    expect(parseTerminalPrompt(later, { cols: TOP_CUT.cols })!.fingerprint).toBe(parsed.fingerprint);
  });

  // Only Claude's own sentence, as the reason's last rows, is dropped: any
  // other row stays in the reason and the hash, so two such dialogs differ.
  it.each([
    ['drawn in the gutter (part of the warning paragraph)', (t: string) => [
      ` │ ⚠ Claude Code will automatically deny this request in ${t}, to avoid blocking progress on an`, ' │ unattended session']],
    ['another time format', (t: string) => [
      ` ⚠ Claude Code will automatically deny this request in ${t} min, to avoid blocking progress on an`, ' unattended session']],
    ['the closing clause missing', (t: string) => [` ⚠ Claude Code will automatically deny this request in ${t}`]],
    ['other words around the time', (t: string) => [
      ` ⚠ Claude Code will automatically approve this request in ${t}, to avoid blocking progress on an`, ' unattended session']],
    ['without the warning glyph', (t: string) => [
      ` Claude Code will automatically deny this request in ${t}, to avoid blocking progress on an`, ' unattended session']],
    ['not the reason\'s last rows', (t: string) => [
      ` ⚠ Claude Code will automatically deny this request in ${t}, to avoid blocking progress on an`, ' unattended session',
      ' Permission rule Bash(rm *) requires confirmation for this command.']],
    ['indented past the prose', (t: string) => [
      `   ⚠ Claude Code will automatically deny this request in ${t}, to avoid blocking progress on an`, '   unattended session']],
  ])('a row %s stays in the reason and the hash', (_label, rows) => {
    const a = parseTerminalPrompt(withCountdown(WHOLE, rows('1:58')), { cols: WHOLE.cols })!;
    const b = parseTerminalPrompt(withCountdown(WHOLE, rows('1:41')), { cols: WHOLE.cols })!;
    expect(a).not.toHaveProperty('autoDenyRemainingMs');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(parse(WHOLE)!.fingerprint);
  });
});

// ── The record and the answer, through the registry ─────────────────────────

const SESSION = '4c1d7e0b-5d3a-4a51-9b7e-2f0b8a6c9d11';
/** The PermissionRequest hook's note, as HookIngest builds it from the live payload. */
const HOOK = {
  source: 'hook' as const,
  toolName: 'Bash',
  toolInput: { command: COMMAND, description: DESCRIPTION },
  hookSessionId: SESSION,
};

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-auto-deny-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(first: Fixture, opts: { transcriptCall?: boolean } = {}) {
  const writes: string[] = [];
  const clock = { now: 1_800_000_000_000 };
  const mark = { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' };
  const screen = { fx: first };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    readPromptScreen: async () => ({ rows: screen.fx.screen, cols: screen.fx.cols, mark: { ...mark } }),
    promptScreenMark: () => ({ ...mark }),
    // Measured: no tool_use in the transcript while the dialog is up. A
    // transcript call (an older build, or written late) binds by its id.
    pendingToolUse: () => (opts.transcriptCall ? { id: 'toolu_01', name: 'Bash', input: HOOK.toolInput, unanswered: 1 } : null),
    agentSessionId: () => SESSION,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, writes, clock, mark, screen };
}

async function create(h: ReturnType<typeof makeRegistry>): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  return record;
}

const answer = (h: ReturnType<typeof makeRegistry>, record: ApprovalRequest) => h.registry.resolve({
  id: record.id,
  decision: 'approve',
  choiceKey: '1',
  promptFingerprint: record.promptFingerprint,
  resolvedBy: 'device Test phone (dev-1)',
  terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
});

describe('auto-deny records', () => {
  it('carry the deadline as an ISO time and the reason without the countdown', async () => {
    const h = makeRegistry(WHOLE);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'Bash',
      question: 'Do you want to proceed?',
      reason: WARNING,
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
      autoDenyAt: new Date(1_800_000_000_000 + 118_000).toISOString(),
    });
  });

  it('a dialog with no countdown has no deadline', async () => {
    const h = makeRegistry({ ...WHOLE, screen: withCountdown(WHOLE, []) });
    const record = await create(h);
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record).not.toHaveProperty('autoDenyAt');
  });

  it('an answer after the countdown ticked (and the TUI redrew it) is pressed', async () => {
    const h = makeRegistry(WHOLE);
    const record = await create(h);
    // The card was read at 1:58; the phone answers at 1:55 (the TUI wrote the
    // new digits in between).
    h.clock.now += Math.max(3_000, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS);
    h.screen.fx = TICK;
    h.mark.bytes += 40;
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('a record refreshed for the same dialog keeps its deadline; a countdown more than 5 s off is a new one', async () => {
    // Bound by the transcript call, so a record refreshed after a key at the
    // desk is answerable again (the hook's proof does not outlive a key).
    const h = makeRegistry(WHOLE, { transcriptCall: true });
    const record = await create(h);
    const deadline = record.autoDenyAt;
    // A key at the desk: the answer refreshes the record from a read at 1:55,
    // whose own deadline lands a second off (the screen shows whole seconds).
    h.clock.now += 4_000;
    h.screen.fx = TICK;
    h.mark.keyInputRevision += 1;
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    const [fresh] = h.registry.list().pending;
    expect(fresh!.id).not.toBe(record.id);
    expect(fresh!.autoDenyAt).toBe(deadline);
    // Thirty seconds on, the screen counts from 1:58 again: another window.
    h.clock.now += 30_000;
    h.screen.fx = WHOLE;
    h.mark.keyInputRevision += 1;
    expect(await answer(h, fresh!)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    const [again] = h.registry.list().pending;
    expect(Date.parse(again!.autoDenyAt!) - Date.parse(deadline!)).toBeGreaterThan(AUTO_DENY_JITTER_MS);
    expect(again!.autoDenyAt).toBe(new Date(h.clock.now + 118_000).toISOString());
  });
});
