import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import { ApiErrorTurnEndWatcher, GRACE_MS, apiErrorFromTranscriptLine } from '../ApiErrorTurnEndWatcher';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-apierr-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ts = '2026-10-17T02:31:37.645Z';
const NOTICE = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
// The entry Claude Code 2.1.302 wrote for the live repro (fields trimmed).
const apiError = (error: string, text: string) => JSON.stringify({
  type: 'assistant', uuid: 'e1', timestamp: ts, isApiErrorMessage: true, error,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const turnDuration = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 458, timestamp: ts });
const reply = JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'retried fine' }] } });

function append(file: string, ...lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
}

function harness() {
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'say hi' } })}\n`);
  let now = 10_000;
  const state = { turnOpen: true };
  const sent: AgentSignal[] = [];
  const watcher = new ApiErrorTurnEndWatcher({
    listSessionIds: () => ['pty-1'],
    getBinding: () => ({ agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file }),
    isTurnOpen: () => state.turnOpen,
    emit: (signal) => sent.push(signal),
    now: () => now,
  });
  watcher.tick(); // seats at the end
  return { file, watcher, sent, state, advance: (ms: number) => { now += ms; } };
}

describe('apiErrorFromTranscriptLine', () => {
  it('reads the error code and the text Claude showed', () => {
    expect(apiErrorFromTranscriptLine(apiError('oauth_org_not_allowed', NOTICE)))
      .toEqual({ error: 'oauth_org_not_allowed', message: NOTICE });
    expect(apiErrorFromTranscriptLine(reply)).toBeNull();
    expect(apiErrorFromTranscriptLine(turnDuration)).toBeNull();
    // A subagent's failure is not the pane's turn end.
    expect(apiErrorFromTranscriptLine(apiError('rate_limit', 'x').replace('"type":"assistant"', '"type":"assistant","isSidechain":true'))).toBeNull();
  });
});

describe('ApiErrorTurnEndWatcher', () => {
  it('closes the open turn with a stop_failure when no hook arrives within the grace', () => {
    const h = harness();
    h.watcher.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    append(h.file, apiError('oauth_org_not_allowed', NOTICE), turnDuration);
    h.watcher.tick();
    expect(h.sent).toEqual([]); // the real hook still has time
    h.advance(GRACE_MS);
    h.watcher.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      kind: 'agent.stop_failure', agent: 'claude', ptyId: 'pty-1', agentSessionId: 's', cwd: dir,
      payload: { error: 'oauth_org_not_allowed', last_assistant_message: NOTICE },
    });
    h.advance(GRACE_MS);
    h.watcher.tick();
    expect(h.sent).toHaveLength(1); // once per entry
  });

  it('stays silent when the StopFailure hook is installed, the turn went on, or the turn is closed', () => {
    const hooked = harness();
    hooked.watcher.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    hooked.advance(500);
    append(hooked.file, apiError('rate_limit', "You've hit your limit"));
    hooked.watcher.noteHookSignal('pty-1', 'agent.stop_failure');
    hooked.watcher.tick();
    hooked.advance(GRACE_MS);
    hooked.watcher.tick();
    expect(hooked.sent).toEqual([]);

    const resumed = harness();
    append(resumed.file, apiError('server_error', 'overloaded'));
    resumed.watcher.tick();
    append(resumed.file, reply);
    resumed.advance(GRACE_MS);
    resumed.watcher.tick();
    expect(resumed.sent).toEqual([]);

    const closed = harness();
    closed.state.turnOpen = false;
    append(closed.file, apiError('oauth_org_not_allowed', NOTICE));
    closed.watcher.tick();
    closed.advance(GRACE_MS);
    closed.watcher.tick();
    expect(closed.sent).toEqual([]);
  });
});
