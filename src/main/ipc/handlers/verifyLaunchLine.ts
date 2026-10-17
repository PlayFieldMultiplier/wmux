/**
 * F26 — a fan-out task pane's launch line, checked after it was written.
 *
 * scheduleInitialCommand counts a write as delivered once the bytes are handed
 * to the session socket. That is not the shell reading them: the renderer's
 * reattach of a new pane tears the create-time socket down (pty:reconnect,
 * connectSessionPipe forceFresh) about when the line is written, and a line
 * typed while wsl.exe is still starting the distro has nothing reading it
 * yet. The pane then sits at a bare prompt and the task is reported running.
 *
 * So, for a task pane only: poll the pane's prompt markers (promptLineState)
 * until the shell has read a line. If it sits at its prompt without having
 * read one, and writes nothing for `quietMs`, the line never arrived (a line
 * the shell took is echoed and shows a command-start), and it is written once
 * more. Never twice: a second idle stretch gives up and leaves the verdict to
 * the fan-out launch check. A pane with no prompt markers (no shell
 * integration) is never written to again.
 *
 * Electron-free so the timing has direct unit coverage.
 */

import { promptLineState, type PromptLineEvent } from '../../../shared/promptLineState';

export const LAUNCH_LINE_VERIFY_WINDOW_MS = 40_000;
export const LAUNCH_LINE_POLL_MS = 750;
export const LAUNCH_LINE_QUIET_MS = 4_000;

export interface LaunchLineRead {
  events: PromptLineEvent[];
  totalBytesWritten: number;
  sessionFound: boolean;
}

export type LaunchLineOutcome = 'read' | 'resent' | 'gave-up' | 'no-evidence' | 'gone';

export interface VerifyLaunchLineOptions {
  /** The pane's prompt events and output size; null when the read failed. */
  read: () => Promise<LaunchLineRead | null>;
  /** Write the launch line again (the same bytes the first write sent). */
  resend: () => boolean | void;
  windowMs?: number;
  pollMs?: number;
  quietMs?: number;
  /** Called once with how it ended. */
  onDone?: (outcome: LaunchLineOutcome) => void;
}

export function verifyLaunchLine(opts: VerifyLaunchLineOptions): { cancel: () => void } {
  const windowMs = opts.windowMs ?? LAUNCH_LINE_VERIFY_WINDOW_MS;
  const pollMs = opts.pollMs ?? LAUNCH_LINE_POLL_MS;
  const quietMs = opts.quietMs ?? LAUNCH_LINE_QUIET_MS;
  const started = Date.now();
  let resent = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Output size when the pane was first seen idle at its prompt, and when. */
  let idle: { bytes: number; at: number } | null = null;

  const finish = (outcome: LaunchLineOutcome): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    opts.onDone?.(outcome);
  };

  const poll = async (): Promise<void> => {
    if (finished) return;
    let r: LaunchLineRead | null = null;
    try {
      r = await opts.read();
    } catch {
      r = null;
    }
    if (finished) return;
    if (r && !r.sessionFound) return finish('gone');
    const now = Date.now();
    // Any amount of output since the prompt is allowed here (a terminal
    // resize repaints the screen): idle is judged by the output standing
    // still for quietMs instead.
    const state = r ? promptLineState(r.events, r.totalBytesWritten, Number.POSITIVE_INFINITY) : 'unknown';
    if (state === 'read') return finish(resent ? 'resent' : 'read');
    if (state === 'idle-at-prompt' && r) {
      if (!idle || idle.bytes !== r.totalBytesWritten) {
        idle = { bytes: r.totalBytesWritten, at: now };
      } else if (now - idle.at >= quietMs) {
        if (resent) return finish('gave-up');
        resent = true;
        idle = null;
        try {
          if (opts.resend() === false) return finish('gave-up');
        } catch {
          return finish('gave-up');
        }
      }
    } else {
      idle = null;
    }
    if (now - started >= windowMs) return finish(resent ? 'gave-up' : 'no-evidence');
    timer = setTimeout(() => void poll(), pollMs);
    timer.unref?.();
  };

  timer = setTimeout(() => void poll(), pollMs);
  timer.unref?.();
  return { cancel: () => finish('gone') };
}
