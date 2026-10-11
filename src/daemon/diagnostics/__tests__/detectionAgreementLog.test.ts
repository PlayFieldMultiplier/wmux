import { describe, expect, it } from 'vitest';
import {
  DetectionAgreementLog,
  MAX_RULE_LABEL_CHARS,
  type DetectionAgreementLogDeps,
} from '../detectionAgreementLog';
import { parseDetectionLog, type DetectionRecord } from '../../../shared/detectionAgreement';

const PTY = 'pty-1';

function setup(overrides: Partial<DetectionAgreementLogDeps> = {}) {
  const lines: string[] = [];
  let authority: { slug: string; exact: boolean } | undefined = { slug: 'claude', exact: true };
  let t = 1_000;
  const log = new DetectionAgreementLog({
    write: (line) => lines.push(line),
    authorityFor: () => authority,
    isBrain: () => false,
    app: '4.2.0',
    os: 'darwin',
    now: () => t++,
    ...overrides,
  });
  return {
    log,
    records: (): DetectionRecord[] => parseDetectionLog(lines.join('')),
    lines,
    setAuthority: (a: typeof authority) => { authority = a; },
  };
}

const hookEvent = (kind: string, status = 'running', agent = 'claude') => ({ status, signal: { kind, agent } });

describe('DetectionAgreementLog', () => {
  it('writes a start record first and newline-terminated JSON lines', () => {
    const { lines, records } = setup();
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(records()[0]).toMatchObject({ type: 'start', app: '4.2.0', os: 'darwin' });
  });

  it('records nothing for a pane until it delivers a turn start, and says so once', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.session_start'));
    log.noteHook(PTY, hookEvent('agent.activity'));
    log.noteDetector(PTY, { agent: 'Claude Code', status: 'waiting', message: 'Ready' });
    const body = records().slice(1);
    expect(body).toEqual([expect.objectContaining({ src: 'skip', why: 'no-turn-start' })]);
  });

  it('records hook transitions only, not repeats of the same state', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    log.noteHook(PTY, hookEvent('agent.activity'));
    log.noteHook(PTY, hookEvent('agent.tool_started'));
    log.noteHook(PTY, hookEvent('agent.stop', 'complete'));
    const hooks = records().filter((r) => 'src' in r && r.src === 'hook');
    expect(hooks.map((r) => (r as { h: string }).h)).toEqual(['busy', 'idle']);
  });

  it('records detector reads on a trusted pane with the decision and a clean, short rule label', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    log.noteDetector(PTY, { agent: 'Claude Code', status: 'waiting', message: `Ready\u001b[0m  for\ninput ${'x'.repeat(100)}` }, 'veto');
    const read = records().find((r) => 'src' in r && r.src === 'det') as { st: string; d: string; r: string };
    expect(read.st).toBe('waiting');
    expect(read.d).toBe('veto');
    expect(read.r.startsWith('Ready [0m for input')).toBe(true);
    expect(read.r.length).toBe(MAX_RULE_LABEL_CHARS);
  });

  it('never writes an API key from screen text to the log, even one the cut would split', () => {
    const { log, lines, records } = setup();
    const key = `sk-proj-${'A1b2'.repeat(8)}`;
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    log.noteDetector(PTY, { agent: 'Claude Code', status: 'waiting', message: `Ready OPENAI_API_KEY=${key}` });
    log.noteDetector(PTY, { agent: 'Claude Code', status: 'waiting', message: `${'y '.repeat(25)}ghp_${'a1B2'.repeat(9)}` });
    const file = lines.join('');
    expect(file).not.toContain(key);
    expect(file).not.toContain('sk-proj');
    expect(file).not.toContain('ghp_');
    expect(file).not.toContain('a1B2a1B2');
    const reads = records().filter((r) => 'src' in r && r.src === 'det') as { r: string }[];
    expect(reads[0].r).toContain('[redacted]');
  });

  it('skips panes whose hook was not routed by exact pty id', () => {
    const { log, records, setAuthority } = setup();
    setAuthority({ slug: 'claude', exact: false });
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    log.noteHook(PTY, hookEvent('agent.stop', 'complete'));
    const body = records().slice(1);
    expect(body).toEqual([expect.objectContaining({ src: 'skip', why: 'inexact-routing' })]);
  });

  it('ignores a detector read for a different agent than the bridge speaks for', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    log.noteDetector(PTY, { agent: 'Codex', status: 'waiting' });
    expect(records().some((r) => 'src' in r && r.src === 'det')).toBe(false);
  });

  it('marks an unconfirmed Codex stop as provisional and keeps the busy truth', () => {
    const { log, records } = setup({ authorityFor: () => ({ slug: 'codex', exact: true }) });
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit', 'running', 'codex'));
    log.noteHook(PTY, hookEvent('agent.stop', 'complete', 'codex'), { provisionalStop: true });
    log.noteHook(PTY, hookEvent('agent.stop', 'complete', 'codex'));
    const hooks = records().filter((r) => 'src' in r && r.src === 'hook') as Array<{ h: string; pv?: true }>;
    expect(hooks).toEqual([
      expect.objectContaining({ h: 'busy' }),
      expect.objectContaining({ h: 'idle', pv: true }),
      expect.objectContaining({ h: 'idle' }),
    ]);
    expect(hooks[2].pv).toBeUndefined();
  });

  it('keeps wmux\'s PreToolUse gate busy instead of recording a dialog', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    // Ungated tool: the broadcast says tool_started; the signal still says awaiting_permission.
    log.noteHook(PTY, { status: 'running', hookKind: 'agent.tool_started', signal: { kind: 'agent.awaiting_permission', agent: 'claude' } });
    log.noteHook(PTY, { status: 'running', hookKind: 'agent.awaiting_permission', signal: { kind: 'agent.awaiting_permission', agent: 'claude' } });
    const hooks = records().filter((r) => 'src' in r && r.src === 'hook') as Array<{ h: string }>;
    expect(hooks.map((r) => r.h)).toEqual(['busy']);
  });

  it('closes a turn from the transcript end, but not with the previous turn\'s end', () => {
    const { log, records } = setup();
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit')); // t = 1001
    log.noteTurnEnd(PTY, 500);
    log.noteTurnEnd(PTY, 1_001);
    const hooks = records().filter((r) => 'src' in r && r.src === 'hook') as Array<{ h: string; k: string; t: number }>;
    expect(hooks).toEqual([
      expect.objectContaining({ h: 'busy' }),
      expect.objectContaining({ h: 'idle', k: 'transcript.turn_end', t: 1_001 }),
    ]);
  });

  it('stamps a hook with its own time unless that time is implausibly old', () => {
    const { log, records } = setup({ now: () => 100_000 });
    log.noteHook(PTY, { status: 'running', signal: { kind: 'agent.user_prompt_submit', agent: 'claude', ts: 98_500 } });
    log.noteHook(PTY, { status: 'complete', signal: { kind: 'agent.stop', agent: 'claude', ts: 1_000 } });
    const hooks = records().filter((r) => 'src' in r && r.src === 'hook') as Array<{ t: number }>;
    expect(hooks.map((r) => r.t)).toEqual([98_500, 100_000]);
  });

  it('excludes deck brain ptys', () => {
    const { log, records } = setup({ isBrain: () => true });
    log.noteHook(PTY, hookEvent('agent.user_prompt_submit'));
    expect(records().slice(1)).toEqual([expect.objectContaining({ src: 'skip', why: 'brain' })]);
  });

  it('never throws when the writer fails', () => {
    const { log } = setup();
    const broken = new DetectionAgreementLog({
      write: () => { throw new Error('disk full'); },
      authorityFor: () => ({ slug: 'claude', exact: true }),
      isBrain: () => false,
      app: 'x',
      os: 'y',
    });
    expect(() => broken.noteHook(PTY, hookEvent('agent.user_prompt_submit'))).not.toThrow();
    expect(() => log.noteDetector(PTY, { agent: 'Claude Code', status: 'waiting' })).not.toThrow();
  });
});
