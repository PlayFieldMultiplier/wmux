// F26 — source-shape guard: the daemon create path checks a fan-out task
// pane's launch line after writing it (verifyLaunchLine), and only a task
// pane's. The handler is a closure inside registerPtyHandlers, which a unit
// test cannot construct (same pattern as pty.handler.promote.test.ts).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');

describe('pty:create launch-line check', () => {
  it('is armed for a bot worker or a fan-out task pane only', () => {
    expect(src).toMatch(/const verifyTaskLine = !!botWorker \|\| !!options\?\.fanoutTaskOf;/);
  });

  it('starts after a write the socket took, once, and re-sends the same line through the same writer', () => {
    const at = src.indexOf('const verifyTaskLine');
    const body = src.slice(at, src.indexOf('onExhausted', at));
    expect(body).toMatch(/const delivered = writeLaunchLine\(cmd\);/);
    expect(body).toMatch(/if \(delivered && verifyTaskLine && !verifying\) \{\s*verifying = true;\s*verifyLaunchLine\(\{/);
    expect(body).toMatch(/return writeLaunchLine\(cmd\);/);
    expect(body).toMatch(/daemonClient\.rpc\('daemon\.readPromptEvents', \{ sessionId, limit: 32 \}, \{ timeoutMs: 2_000 \}\)/);
  });
});
