/**
 * SampleTaskRunner — wait for an OSC133 prompt-ready handshake on a PTY data
 * source, then inject the deterministic `SAMPLE_TASK_COMMAND` followed by `\r`.
 *
 * Architectural note (decisions.md D7-C1+C2):
 *   wmux has two PTY data paths — non-daemon (`PTYBridge.addMiddleware`) and
 *   daemon (`daemonClient.on('session:data')`). This runner is intentionally
 *   agnostic to either: it consumes a `PtyDataSource` adapter that the
 *   FirstRunOrchestrator (T4) wires up.
 *
 * Lifecycle:
 *   - `run(source, signal)` subscribes to `source.onData`, accumulates a
 *     bounded byte buffer, and scans for the strict OSC133 "A" sequence
 *     (BEL or ST terminator — see `OSC133_PROMPT_READY_PATTERNS`).
 *   - Then, once subscribed, asks `source.atPrompt()` whether the shell is
 *     already at a prompt: a pane mounted just before the run has usually
 *     drawn its prompt already, and that `133;A` will never arrive again.
 *   - On match: writes the command, disposes, resolves `{ outcome: 'ok' }`.
 *   - On `OSC133_TIMEOUT_MS` elapsed: disposes, resolves `{ outcome: 'timeout' }`.
 *   - On `signal` aborted (either at call time or mid-flight): disposes,
 *     resolves `{ outcome: 'aborted' }`. The promise never rejects.
 *
 * The buffer is capped (`MAX_BUFFER_BYTES`, 64 KiB) to prevent unbounded
 * growth on long-running shells that never emit OSC133. We slice from the
 * tail and keep at least `OSC_OVERLAP_BYTES` bytes of overlap so a sequence
 * straddling the cap boundary still matches.
 *
 * See: progress.md (T3), decisions.md (D3, D7-C1, D7-C2), src/shared/firstRun.ts.
 */

import {
  OSC133_PROMPT_READY_PATTERNS,
  OSC133_TIMEOUT_MS,
  SAMPLE_TASK_COMMAND,
  type SampleTaskOutcome,
} from '../../shared/firstRun';

/** Adapter abstracting the underlying PTY transport (PTYBridge or daemon). */
export interface PtyDataSource {
  /** Subscribe to incoming PTY data. Returns an unsubscribe function. */
  onData(handler: (chunk: string) => void): () => void;
  /** Write data into the PTY. */
  write(data: string): void;
  /**
   * Whether the shell has already drawn a prompt and started nothing since.
   * Read after `onData` subscribed, so a prompt is either in this answer or
   * still to arrive as data. Absent when the transport keeps no such state.
   */
  atPrompt?(): Promise<boolean>;
}

/** Hard cap on the accumulated scan buffer (64 KiB). */
const MAX_BUFFER_BYTES = 64 * 1024;

/**
 * When the buffer exceeds the cap we slice from the tail. We keep a small
 * overlap (longer than any OSC133 prompt-ready sequence — `\x1b]133;A\x1b\\`
 * is 8 bytes) so a sequence that straddles the slice boundary still matches.
 */
const OSC_OVERLAP_BYTES = 64;

export class SampleTaskRunner {
  /**
   * Listen for OSC133 prompt-ready, then inject `SAMPLE_TASK_COMMAND + '\r'`.
   * Resolves with the outcome; never rejects.
   */
  async run(
    source: PtyDataSource,
    signal: AbortSignal,
  ): Promise<{ outcome: SampleTaskOutcome }> {
    return new Promise<{ outcome: SampleTaskOutcome }>((resolve) => {
      // Idempotent cleanup: only the first finish-branch wins.
      let disposed = false;
      let buffer = '';
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (outcome: SampleTaskOutcome): void => {
        if (disposed) return;
        disposed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal.removeEventListener('abort', onAbort);
        if (unsubscribe !== null) {
          try {
            unsubscribe();
          } catch {
            /* best-effort: source may have already torn down */
          }
          unsubscribe = null;
        }
        resolve({ outcome });
      };

      const onAbort = (): void => {
        finish('aborted');
      };

      // Pre-call abort: resolve synchronously without subscribing.
      if (signal.aborted) {
        finish('aborted');
        return;
      }

      const inject = (): void => {
        try {
          source.write(SAMPLE_TASK_COMMAND + '\r');
        } catch {
          /* best-effort: write failures still report 'ok' to caller —
           * the renderer-side fallback handles "Press Enter" UX */
        }
        finish('ok');
      };

      const onChunk = (chunk: string): void => {
        if (disposed) return;
        buffer += chunk;
        // Cap the buffer length, retaining a small overlap so a sequence
        // straddling the slice boundary still matches on the next chunk.
        if (buffer.length > MAX_BUFFER_BYTES) {
          buffer = buffer.slice(-(MAX_BUFFER_BYTES - OSC_OVERLAP_BYTES));
        }
        for (const pattern of OSC133_PROMPT_READY_PATTERNS) {
          if (pattern.test(buffer)) {
            inject();
            return;
          }
        }
      };

      // Wire up subscriptions before starting the timer so the very first
      // emitted chunk cannot race past us.
      try {
        unsubscribe = source.onData(onChunk);
      } catch {
        // Defensive: if the adapter explodes on subscribe, treat as timeout
        // path — caller's fallback UX still applies. We have nothing to
        // unsubscribe.
        unsubscribe = null;
        finish('timeout');
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        finish('timeout');
      }, OSC133_TIMEOUT_MS);

      // The prompt may have been drawn before we subscribed. Read the shell's
      // current state only now, so nothing falls between that read and the
      // live data; a live match that wins first makes this a no-op.
      if (source.atPrompt) {
        source.atPrompt().then(
          (ready) => { if (ready && !disposed) inject(); },
          () => { /* unknown: keep waiting on live data */ },
        );
      }
    });
  }
}
