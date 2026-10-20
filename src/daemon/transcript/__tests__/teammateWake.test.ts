import { describe, expect, it, vi } from 'vitest';
import { TeammateWakes, teammateWakeFromTranscriptLine } from '../teammateWake';

// Replays a live Agent Teams capture (Claude Code 2.1.304, #2494): the lead's
// hooks with their fire times and the lead transcript's entries, text shortened.
const PATH = '/home/u/.claude/projects/p/lead.jsonl';
const ms = (t: string): number => Date.parse(`2026-10-20T${t}Z`);

const userLine = (uuid: string, time: string, content: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({
  parentUuid: 'p', isSidechain: false, promptId: 'eb3f3689-f4f8-49e6-ab6f-a8dede58eedc', type: 'user',
  message: { role: 'user', content }, uuid, timestamp: `2026-10-20T${time}Z`, userType: 'external', version: '2.1.304', ...extra,
});
const wakeText = (body: string): string =>
  `Another Claude session sent a message:\n<teammate-message teammate_id="sleeper" color="blue">\n${body}\n</teammate-message>\n\nThis came from another Claude session.`;

const HUMAN = userLine('u-human', '20:03:49.108', 'Create an agent team with one teammate…', { turnPosition: { promptIndex: 1, turnIndex: 1 }, turnOrigin: 'human' });
const WAKE_1 = userLine('u-wake-1', '20:04:14.879', wakeText('done sleeping'), { turnPosition: { promptIndex: 1, turnIndex: 2 } });
const WAKE_2 = userLine('u-wake-2', '20:04:21.951', wakeText('{"type":"idle_notification","from":"sleeper"}'), { turnPosition: { promptIndex: 1, turnIndex: 3 } });

function rig(opts: { reader?: boolean; mayOpen?: boolean } = {}) {
  const emit = vi.fn();
  const wakes = new TeammateWakes({ isReader: () => opts.reader ?? true, mayOpen: () => opts.mayOpen ?? true, emit });
  const hook = (kind: string, t: string): void => wakes.noteHookSignal('pty-1', kind, ms(t));
  const line = (l: string): void => wakes.noteLine('pty-1', PATH, l);
  return { wakes, emit, hook, line };
}

describe('teammateWakeFromTranscriptLine', () => {
  it('reads a woken turn entry, as a string or a text block, and nothing else', () => {
    expect(teammateWakeFromTranscriptLine(WAKE_1)).toEqual({ uuid: 'u-wake-1', at: ms('20:04:14.879') });
    expect(teammateWakeFromTranscriptLine(userLine('u-b', '20:04:14.879', [{ type: 'text', text: wakeText('x') }]))?.uuid).toBe('u-b');
    expect(teammateWakeFromTranscriptLine(HUMAN)).toBeNull();
    // A subagent's entry, a quote of the tag in a human prompt, and an assistant echo are not wakes.
    expect(teammateWakeFromTranscriptLine(userLine('u-s', '20:04:14.879', wakeText('x'), { isSidechain: true }))).toBeNull();
    expect(teammateWakeFromTranscriptLine(userLine('u-q', '20:04:14.879', 'why does <teammate-message> show up?'))).toBeNull();
    expect(teammateWakeFromTranscriptLine(JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-10-20T20:04:14.879Z', message: { content: wakeText('x') } }))).toBeNull();
  });
});

describe('TeammateWakes — the live capture', () => {
  it('opens each woken lead turn once, at its entry, in the order the hooks and lines arrived', () => {
    const { emit, hook, line } = rig();
    hook('agent.session_start', '20:03:39.493');
    hook('agent.user_prompt_submit', '20:03:49.169');
    line(HUMAN);
    hook('agent.stop', '20:03:57.365');
    // The teammate's message wakes the lead: no prompt hook, only the entry.
    line(WAKE_1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith('pty-1', ms('20:04:14.879'));
    // The tail is read before the daemon ingests the Stop that fired 15 ms
    // before the next entry: the entry waits for it.
    line(WAKE_2);
    expect(emit).toHaveBeenCalledTimes(1);
    hook('agent.stop', '20:04:21.936');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('pty-1', ms('20:04:21.951'));
    hook('agent.stop', '20:04:23.881');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('never opens a turn twice for one entry: a replay, a second read or a restart', () => {
    const { emit, hook, line, wakes } = rig();
    hook('agent.user_prompt_submit', '20:03:49.169');
    hook('agent.stop', '20:03:57.365');
    line(WAKE_1);
    hook('agent.stop', '20:04:21.936');
    // The watcher replays the window before its offset.
    line(WAKE_1);
    expect(emit).toHaveBeenCalledTimes(1);
    // A daemon restart knows no turn end: the replayed entry is older than the first Stop it sees.
    wakes.dropSession('pty-1');
    line(WAKE_1);
    hook('agent.stop', '20:04:23.881');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('starts nothing for an entry the lead read mid-turn, before any turn end, or after a prompt', () => {
    const mid = rig();
    mid.hook('agent.user_prompt_submit', '20:04:10.000');
    mid.line(WAKE_1);
    mid.hook('agent.stop', '20:04:21.936');
    expect(mid.emit).not.toHaveBeenCalled();

    const prompted = rig();
    prompted.hook('agent.stop', '20:03:57.365');
    prompted.hook('agent.user_prompt_submit', '20:04:10.000');
    prompted.line(WAKE_1);
    prompted.hook('agent.stop', '20:04:21.936');
    expect(prompted.emit).not.toHaveBeenCalled();

    const fresh = rig();
    fresh.line(WAKE_1);
    expect(fresh.emit).not.toHaveBeenCalled();
  });

  it('leaves a pane that no longer reads the file, or that a dialog holds, alone', () => {
    for (const opts of [{ reader: false }, { mayOpen: false }]) {
      const { emit, hook, line } = rig(opts);
      hook('agent.stop', '20:03:57.365');
      line(WAKE_1);
      expect(emit).not.toHaveBeenCalled();
    }
  });
});
