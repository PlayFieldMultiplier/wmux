import { describe, expect, it } from 'vitest';
import type { CommitOrigin, CommitOriginPane } from '../../../shared/commitOrigin';
import { CommitOriginCapture, SCREEN_CHECK_DELAYS_MS } from '../CommitOriginCapture';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMIT = { sha: SHA, at: 1_000, op: 'commit' as const };
const SHOWN = '[main 0123456] fix the thing';

function rig(texts: Record<string, () => string | null>) {
  const added: CommitOrigin[] = [];
  const sessions: Record<string, string> = { p1: 's-1', p2: 's-2' };
  let round = 0;
  const capture = new CommitOriginCapture({
    store: { add: (o) => { added.push(o); } },
    paneText: async (id) => texts[id]?.() ?? null,
    pane: (id): CommitOriginPane => ({ ptyId: id, workspaceId: `ws-${id}`, agent: 'claude', agentSessionId: sessions[id] ?? null }),
    taskOf: (id) => (id === 'p1' ? 'task-1' : null),
    watch: () => ({ close: () => undefined }),
    // Every wait ends at once; `round` counts the screen checks.
    setTimer: (fn) => { round++; fn(); },
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { capture, added, sessions, round: () => round, settle };
}

describe('CommitOriginCapture', () => {
  it('attributes the commit to the one pane whose output shows its short SHA', async () => {
    let shown = false;
    const r = rig({ p1: () => (shown ? SHOWN : '$ git commit'), p2: () => 'idle' });
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }, { sessionId: 'p2', gitDir: '/r/.git', branch: 'main' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    // The panes are read when the line lands: a session switch afterwards does not relink.
    r.sessions.p1 = 's-later';
    shown = true;
    await r.settle();
    expect(r.added).toEqual([{
      ...COMMIT, branch: 'main', evidence: 'screen',
      attributed: { ptyId: 'p1', workspaceId: 'ws-p1', agent: 'claude', agentSessionId: 's-1', taskId: 'task-1' },
    }]);
  });

  it('a lone pane that never shows it is a candidate, not an attribution', async () => {
    const r = rig({ p1: () => 'nothing here' });
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: '1a2b3c4d' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    await r.settle();
    expect(r.round()).toBe(SCREEN_CHECK_DELAYS_MS.filter((d) => d > 0).length);
    expect(r.added).toEqual([{
      ...COMMIT, branch: null, // a detached HEAD's label is no branch
      evidence: 'only-pane',
      candidates: [{ ptyId: 'p1', workspaceId: 'ws-p1', agent: 'claude', agentSessionId: 's-1' }],
    }]);
  });

  it('two panes showing it (one ran git log) attribute nothing; panes elsewhere are not candidates', async () => {
    const r = rig({ p1: () => SHOWN, p2: () => SHOWN });
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }, { sessionId: 'p2', gitDir: '/r/.git', branch: 'main' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    r.capture.onCommit('/other/.git', { ...COMMIT, sha: 'f'.repeat(40) });
    await r.settle();
    expect(r.added).toHaveLength(1);
    expect(r.added[0]).toMatchObject({ evidence: 'none', candidates: [{ ptyId: 'p1' }, { ptyId: 'p2' }] });
    expect(r.added[0].attributed).toBeUndefined();
  });
});
