import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #2349 — what a failed fan-out spawn tells main about its pane. Main removes
 * the task's worktree only on proof that no agent can still run there:
 * `noPty: true` (no PTY was ever created) or a `ptyId` it can ask the daemon
 * about. A `noPty` on a failure after pty.create succeeded would let main
 * force-remove a folder a live agent works in.
 *
 * Source-structural, like useRpcBridge.fanoutRole.test.ts: `handleRpcMethod`
 * pulls in the store and window and cannot be imported under vitest.
 */
describe('useRpcBridge — fan-out spawn failures and the PTY', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const block = (() => {
    const m = src.match(/if \(method === 'fanout\.spawnWorkspace'\)[\s\S]*?\n {2}\}\n/);
    if (!m) throw new Error('the fanout.spawnWorkspace handler was not found in useRpcBridge.ts');
    return m[0];
  })();
  const created = block.indexOf('ptyId = created.id;');
  /** Every `return { error ... }` statement, with where it sits. */
  const errorReturns = [...block.matchAll(/return \{\s*error:[\s\S]*?\};/g)].map((m) => ({ at: m.index ?? 0, text: m[0] }));

  it('says noPty on every failure before a PTY exists, pty.create refused included', () => {
    expect(created).toBeGreaterThan(-1);
    const before = errorReturns.filter((r) => r.at < created || /PTY create failed/.test(r.text));
    expect(before.length).toBeGreaterThanOrEqual(4);
    for (const r of before) expect(r.text).toMatch(/noPty: true/);
  });

  it('names the created PTY, and never says noPty, once pty.create succeeded', () => {
    // The catch of pty.create sits right below the success line; it is the
    // refusal, covered above.
    const after = errorReturns.filter((r) => r.at > created && !/PTY create failed/.test(r.text));
    expect(after.length).toBeGreaterThanOrEqual(1);
    for (const r of after) {
      expect(r.text).not.toMatch(/noPty/);
      expect(r.text).toMatch(/\bptyId\b/);
    }
  });
});
