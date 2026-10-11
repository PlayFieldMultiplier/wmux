/**
 * Leftover background-work mining for Stop envelopes.
 *
 * The count must answer ONE question at Stop time: are background tasks the
 * agent started still running? Verified transcript shapes (live spike
 * 2026-08-15): a `run_in_background` Bash tool_use gets an IMMEDIATE
 * "Command running in background" tool_result (not a completion), and the
 * real settlement is a durable task-notification record —
 * `queue-operation` content or `attachment(queued_command).prompt` —
 * carrying <tool-use-id> and <status>completed|failed</status>.
 *
 * These tests run the REAL bridge function: the CLI entrypoint is stripped
 * (main() runs at module top level and would read stdin) and the miner
 * re-exported from a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let count: (transcriptPath: string) => number;

function fixture(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function bgStart(id: string) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', run_in_background: true } },
      ],
    },
  };
}

function bgStartResult(id: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: id, type: 'tool_result', content: `Command running in background with ID: task1. Output is being written to: /tmp/x` },
      ],
    },
  };
}

function notificationRecord(id: string, status: 'completed' | 'failed') {
  const body = `<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;
  return { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body };
}

function notificationAttachment(id: string, status: 'completed' | 'failed') {
  const body = `<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;
  return { type: 'attachment', attachment: { type: 'queued_command', prompt: body, commandMode: 'task-notification', timestamp: '2026-08-15T00:00:00.000Z' }, timestamp: '2026-08-15T00:00:00.000Z' };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-lw-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  // Strip the shebang — vite's transform (which intercepts even runtime
  // dynamic imports under vitest) rejects it with a SyntaxError on Windows.
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { countLeftoverBackgroundTasks };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ countLeftoverBackgroundTasks: count } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('countLeftoverBackgroundTasks', () => {
  it('in-flight task: start + immediate "running" result, no notification → 1', () => {
    const p = fixture('inflight.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('settled via queue-operation notification → 0', () => {
    const p = fixture('settled-queue.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
      notificationRecord('call_a', 'completed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('settles even with leading whitespace in the body and a non-whitelisted status (fail-open)', () => {
    // review-team catch: `startsWith` + a (completed|failed) whitelist would
    // miss a body carrying leading whitespace or a future terminal status
    // value — the task would then count as running FOREVER and permanently
    // suppress every later Stop alarm, the exact failure mode this miner
    // exists to avoid. Any <status> settles; a spurious settle at worst
    // fires one window-gated alarm.
    const body = '  \n<task-notification>\n<tool-use-id>call_w</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>killed</status>\n<summary>Background command finished</summary>\n</task-notification>';
    const p = fixture('settled-loose.jsonl', [
      bgStart('call_w'),
      bgStartResult('call_w'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body },
    ]);
    expect(count(p)).toBe(0);
  });

  it('settles when the notification carries NO <status> tag at all', () => {
    // The value whitelist was already loosened; requiring the TAG had the same
    // failure mode and was left in place. A task-notification whose status tag
    // is absent, renamed, or moved would never settle its id, so leftover
    // stayed above zero and every later Stop in that session was suppressed —
    // permanent silence, from a shape change we do not control. The ARRIVAL of
    // a notification for an id is the settlement; the status is diagnostic.
    const body = '<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>call_nostatus</tool-use-id>\n<summary>Background command finished</summary>\n</task-notification>';
    const p = fixture('settled-no-status.jsonl', [
      bgStart('call_nostatus'),
      bgStartResult('call_nostatus'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body },
    ]);
    expect(count(p)).toBe(0);
  });

  it('settled via the DURABLE attachment shape (queue already drained) → 0', () => {
    const p = fixture('settled-attachment.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
      notificationAttachment('call_a', 'failed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('a failed task also settles (it is not leftover work)', () => {
    const p = fixture('settled-failed.jsonl', [
      bgStart('call_a'),
      notificationRecord('call_a', 'failed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('two starts, one settled → 1', () => {
    const p = fixture('two.jsonl', [
      bgStart('call_a'),
      bgStart('call_b'),
      bgStartResult('call_a'),
      bgStartResult('call_b'),
      notificationRecord('call_a', 'completed'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('a synchronously REJECTED background attempt is not leftover work (live-spike false positive)', () => {
    // Real shape observed 2026-08-15: the worktree-isolation hook refused the
    // command, so the tool_result is an error string — no task ever spawned,
    // no task-notification will ever arrive. Counting it would suppress every
    // later Stop alarm for the rest of the session.
    const p = fixture('rejected.jsonl', [
      bgStart('call_r'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'call_r', type: 'tool_result', content: 'This session is isolated in the worktree /x, but this command is too complex to verify that it stays inside the worktree; break it into plain, separate commands' },
          ],
        },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('foreground Bash tool_use is ignored entirely', () => {
    const p = fixture('foreground.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_f', name: 'Bash', input: { command: 'ls' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'call_f', type: 'tool_result', content: 'file1\nfile2' }] },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('non-Bash background tools are ignored', () => {
    const p = fixture('other-tool.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_t', name: 'Task', input: { prompt: 'x', run_in_background: true } }] },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('fail-open: missing file → 0', () => {
    expect(count(path.join(tmp, 'does-not-exist.jsonl'))).toBe(0);
  });

  it('fail-open: malformed lines are skipped, not fatal', () => {
    const p = path.join(tmp, 'malformed.jsonl');
    writeFileSync(
      p,
      '{not json\n' + JSON.stringify(bgStart('call_a')) + '\n' + JSON.stringify(bgStartResult('call_a')) + '\n',
      'utf8',
    );
    expect(count(p)).toBe(1);
  });

  it('a background tool_use with NO tool_result is conservatively not counted', () => {
    // The immediate result is always written after the dispatch, so a
    // result-less start at Stop time means a tail-boundary anomaly — count
    // nothing rather than risk permanent suppression.
    const p = fixture('resultless.jsonl', [bgStart('call_x')]);
    expect(count(p)).toBe(0);
  });
});

// A background task the agent stopped itself never gets a task-notification
// (live transcript, 2026-10-11). Shapes copied from that transcript.
function bgStartResultWithTaskId(id: string, taskId: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: id, type: 'tool_result', content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output` },
      ],
    },
  };
}

function taskStop(callId: string, taskId: string, name = 'TaskStop', key = 'task_id') {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name, input: { [key]: taskId }, caller: { type: 'direct' } }],
    },
  };
}

function taskStopResult(callId: string, taskId: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        tool_use_id: callId,
        type: 'tool_result',
        content: JSON.stringify({ message: `Successfully stopped task: ${taskId} (npx electron . > /dev/null 2>&1)`, task_id: taskId, task_type: 'local_bash' }),
      }],
    },
  };
}

function notificationFor(id: string, taskId: string) {
  const body = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Background command "Relaunch a clean app instance" completed (exit code 0)</summary>\n</task-notification>`;
  return { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-10T21:26:26.345Z', sessionId: 's1', content: body };
}

describe('countLeftoverBackgroundTasks — tasks the agent stopped itself', () => {
  it('a TaskStop\'d background shell is settled (no notification ever arrives for it)', () => {
    const p = fixture('taskstop.jsonl', [
      bgStart('call_s'),
      bgStartResultWithTaskId('call_s', 'bhq42z0r3'),
      taskStop('call_k', 'bhq42z0r3'),
      taskStopResult('call_k', 'bhq42z0r3'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('the older KillShell (shell_id) and KillBash (bash_id) names settle too', () => {
    const p = fixture('killshell.jsonl', [
      bgStart('call_1'),
      bgStartResultWithTaskId('call_1', 'shell1'),
      bgStart('call_2'),
      bgStartResultWithTaskId('call_2', 'shell2'),
      taskStop('call_k1', 'shell1', 'KillShell', 'shell_id'),
      taskStop('call_k2', 'shell2', 'KillBash', 'bash_id'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('stopping one task leaves a different, still-running task counted', () => {
    const p = fixture('taskstop-other.jsonl', [
      bgStart('call_a'),
      bgStartResultWithTaskId('call_a', 'taska'),
      bgStart('call_b'),
      bgStartResultWithTaskId('call_b', 'taskb'),
      taskStop('call_k', 'taska'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('live sequence: stopped relaunches + one real background shell → 1 at the turn end, 0 after its notification turn', () => {
    // The DocuCompare pane (2026-10-11): the agent relaunched its app several
    // times, stopping each previous `npx electron .` with TaskStop, then left
    // one relaunch running when its turn ended ("1 shell still running").
    // That shell finished later and Claude Code ran a task-notification turn
    // (UserPromptSubmit + Stop). Its Stop must report NO leftover work, or
    // HookIngest projects it as `running` and the turn latch never closes.
    const stopped = ['b0hydmf3e', 'bo39v4t92', 'bu64yawau', 'bu2qqfwny', 'bfbp60qth', 'bhq42z0r3'];
    const history: unknown[] = [];
    stopped.forEach((taskId, i) => {
      history.push(bgStart(`call_start_${i}`), bgStartResultWithTaskId(`call_start_${i}`, taskId));
      history.push(taskStop(`call_stop_${i}`, taskId), taskStopResult(`call_stop_${i}`, taskId));
    });
    history.push(bgStart('call_live'), bgStartResultWithTaskId('call_live', 'bv8plccqv'));

    // Stop at the end of the turn: the one live shell is real leftover work.
    expect(count(fixture('live-turn-end.jsonl', history))).toBe(1);

    // Stop at the end of the task-notification turn: nothing is left.
    history.push(notificationFor('call_live', 'bv8plccqv'));
    expect(count(fixture('live-notification-turn.jsonl', history))).toBe(0);
  });
});

function userPrompt(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content: text }, ...extra };
}

describe('countLeftoverBackgroundTasks — scoped to the turn that just ended', () => {
  it('a server left running from an EARLIER turn is not leftover work (live CompareIt pane)', () => {
    // 2026-10-11: the agent relaunched `npm run dev` in the background, then
    // answered several more prompts. The server never ends, so counting it
    // kept every later Stop `running` and the sidebar showed a live dot.
    const p = fixture('earlier-turn-server.jsonl', [
      userPrompt('relaunch the app'),
      bgStart('call_dev'),
      bgStartResultWithTaskId('call_dev', 'b8r7r8zur'),
      userPrompt('commit and push'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('a shell dispatched in the ending turn still counts', () => {
    const p = fixture('this-turn-shell.jsonl', [
      userPrompt('run the tests in the background'),
      bgStart('call_t'),
      bgStartResultWithTaskId('call_t', 'btest'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('meta user records (skill bodies, caveats) do not open a new turn', () => {
    const p = fixture('meta-user.jsonl', [
      userPrompt('build it'),
      bgStart('call_b'),
      bgStartResultWithTaskId('call_b', 'bbuild'),
      userPrompt('Base directory for this skill: …', { isMeta: true }),
    ]);
    expect(count(p)).toBe(1);
  });

  it('a task-notification turn continues its turn: a sibling still running keeps counting', () => {
    // Claude Code writes the turn it runs for a finished shell as a non-meta
    // user record with a string body. The other shell from the same turn is
    // still running, so that turn's Stop has leftover work (#1096).
    const p = fixture('sibling-after-notification.jsonl', [
      userPrompt('run unit and e2e in the background'),
      bgStart('call_unit'),
      bgStartResultWithTaskId('call_unit', 'bunit'),
      bgStart('call_e2e'),
      bgStartResultWithTaskId('call_e2e', 'be2e'),
      notificationFor('call_unit', 'bunit'),
      userPrompt(notificationFor('call_unit', 'bunit').content, { origin: { kind: 'task-notification' } }),
    ]);
    expect(count(p)).toBe(1);
  });

  it('a compact summary does not open a new turn', () => {
    const p = fixture('compact-mid-turn.jsonl', [
      userPrompt('build it'),
      bgStart('call_c'),
      bgStartResultWithTaskId('call_c', 'bcompact'),
      userPrompt('This session is being continued from a previous conversation…', {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]);
    expect(count(p)).toBe(1);
  });

  it('text-block prompts open a new turn too', () => {
    const p = fixture('array-prompt.jsonl', [
      bgStart('call_old'),
      bgStartResultWithTaskId('call_old', 'bold'),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    ]);
    expect(count(p)).toBe(0);
  });
});
