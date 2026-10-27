import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Probe } from '../../../main/pty/gitContextWatch';
import type { CommitOrigin, CommitOriginPane } from '../../../shared/commitOrigin';
import { CommitOriginCapture, SCREEN_CHECK_DELAYS_MS } from '../CommitOriginCapture';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMIT = { sha: SHA, at: 1_000, op: 'commit' as const };
const SHOWN = '  ⎿  [main 0123456] fix the thing';
const OLD = 'a'.repeat(40);
const reflogLine = (sha: string, what = 'commit: x', name = 'Dev') => `${OLD} ${sha} ${name} <d@example.com> 1793116920 +0900\t${what}\n`;

function rig(texts: Record<string, () => string | null>, live: string[] = ['p1', 'p2']) {
  const added: CommitOrigin[] = [];
  const sessions: Record<string, string> = { p1: 's-1', p2: 's-2', p3: 's-3' };
  let rounds = 0;
  // logs/HEAD, as the reader would answer for it.
  const file = { bytes: Buffer.alloc(0), ino: 1, present: true };
  const watches: Array<{ dir: string; onChange: (f: string | null) => void; onError: () => void }> = [];
  const read = async (probe: Probe) => {
    if (probe.op === 'open') return 'opened';
    if (probe.op !== 'tail' || !file.present) return null;
    const from = Math.min(probe.from ?? 0, file.bytes.length);
    return JSON.stringify({ size: file.bytes.length, ino: file.ino, bytes: file.bytes.subarray(from, from + 65536).toString('base64') });
  };
  const capture = new CommitOriginCapture({
    store: { add: (o) => { added.push(o); } },
    read,
    livePanes: () => live,
    paneText: async (id) => texts[id]?.() ?? null,
    pane: (id): CommitOriginPane => ({ ptyId: id, workspaceId: `ws-${id}`, agent: 'claude', agentSessionId: sessions[id] ?? null }),
    taskOf: (id) => (id === 'p1' ? 'task-1' : null),
    watch: (dir, onChange, onError) => {
      watches.push({ dir, onChange, onError });
      return { close: () => undefined };
    },
    setTimer: (fn) => { rounds++; fn(); },
  });
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return { capture, added, sessions, file, watches, rounds: () => rounds, settle };
}

describe('CommitOriginCapture: evidence', () => {
  it('attributes the commit to the one pane that showed git\'s summary line, as it was when the line landed', async () => {
    let shown = false;
    const r = rig({ p1: () => (shown ? SHOWN : '$ git commit'), p2: () => 'idle  @0123456' });
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }, { sessionId: 'p2', gitDir: '/r/.git', branch: 'main' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    r.sessions.p1 = 's-later'; // a later session switch does not relink
    shown = true;
    await r.settle();
    expect(r.added).toEqual([{
      ...COMMIT, branch: 'main', evidence: 'screen',
      attributed: { ptyId: 'p1', workspaceId: 'ws-p1', agent: 'claude', agentSessionId: 's-1', taskId: 'task-1' },
    }]);
  });

  it('finds the pane that committed from another directory', async () => {
    const r = rig({ p1: () => 'idle', p3: () => '[detached HEAD 0123456] x' }, ['p1', 'p3']);
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    await r.settle();
    expect(r.added[0]).toMatchObject({ evidence: 'screen', attributed: { ptyId: 'p3' } });
  });

  it('a lone pane that never shows it is a candidate, not an attribution', async () => {
    const r = rig({ p1: () => 'commit 0123456789abcdef (HEAD -> main)' }, ['p1']);
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: '1a2b3c4d' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    await r.settle();
    expect(r.rounds()).toBe(SCREEN_CHECK_DELAYS_MS.filter((d) => d > 0).length);
    expect(r.added).toEqual([{
      ...COMMIT, branch: null, // a detached HEAD's label is no branch
      evidence: 'only-pane',
      candidates: [{ ptyId: 'p1', workspaceId: 'ws-p1', agent: 'claude', agentSessionId: 's-1' }],
    }]);
  });

  it('two panes showing it attribute nothing; a commit in a worktree with no pane is not recorded', async () => {
    const r = rig({ p1: () => SHOWN, p2: () => SHOWN });
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }, { sessionId: 'p2', gitDir: '/r/.git', branch: 'main' }]);
    r.capture.onCommit('/r/.git', COMMIT);
    r.capture.onCommit('/other/.git', { ...COMMIT, sha: 'f'.repeat(40) });
    await r.settle();
    expect(r.added).toHaveLength(1);
    expect(r.added[0]).toMatchObject({ evidence: 'none', candidates: [{ ptyId: 'p1' }, { ptyId: 'p2' }] });
    expect(r.added[0].attributed).toBeUndefined();
  });

  it('stopped mid-window, it records the candidates and attributes nothing', async () => {
    const r = rig({ p1: () => SHOWN }, ['p1']);
    let wake: (() => void) | null = null;
    const capture = new CommitOriginCapture({
      store: { add: (o) => { r.added.push(o); } },
      read: async () => null,
      livePanes: () => ['p1'],
      paneText: async () => SHOWN,
      pane: (id) => ({ ptyId: id, workspaceId: null, agent: null, agentSessionId: null }),
      taskOf: () => null,
      watch: () => null,
      setTimer: (fn) => { wake = fn; },
    });
    capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }]);
    capture.onCommit('/r/.git', COMMIT);
    await r.settle();
    capture.dispose();
    expect(r.added).toEqual([{ ...COMMIT, branch: 'main', evidence: 'only-pane', candidates: [{ ptyId: 'p1', workspaceId: null, agent: null, agentSessionId: null }] }]);
    (wake as (() => void) | null)?.();
    await r.settle();
    expect(r.added).toHaveLength(1);
  });
});

describe('CommitOriginCapture: the reflog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function started(r: ReturnType<typeof rig>) {
    r.capture.sync([{ sessionId: 'p1', gitDir: '/r/.git', branch: 'main' }]);
    await vi.advanceTimersByTimeAsync(0);
    const watch = r.watches.at(-1);
    if (!watch) throw new Error('not armed');
    return watch;
  }
  const append = (r: ReturnType<typeof rig>, line: string | Buffer) => {
    r.file.bytes = Buffer.concat([r.file.bytes, typeof line === 'string' ? Buffer.from(line) : line]);
  };

  it('reads only what is appended, by bytes, across lines that are not UTF-8', async () => {
    const r = rig({}, ['p1']);
    append(r, reflogLine('1'.repeat(40)));
    const watch = await started(r);
    expect(watch.dir).toBe('/r/.git/logs');
    // A Latin-1 name: one byte that is not UTF-8.
    append(r, Buffer.concat([Buffer.from(`${OLD} ${'2'.repeat(40)} Jos`), Buffer.from([0xe9]), Buffer.from(' <d@example.com> 1793116920 +0900\tcommit: x\n')]));
    append(r, reflogLine('3'.repeat(40), 'commit (amend): y'));
    watch.onChange('HEAD');
    await vi.advanceTimersByTimeAsync(200);
    append(r, reflogLine('4'.repeat(40)));
    watch.onChange('HEAD');
    await vi.advanceTimersByTimeAsync(200);
    expect(r.added.map((o) => [o.sha[0], o.op])).toEqual([['2', 'commit'], ['3', 'amend'], ['4', 'commit']]);
  });

  it('a rewritten reflog is read again from its end, recording only new lines, once', async () => {
    const r = rig({}, ['p1']);
    append(r, reflogLine('1'.repeat(40)));
    const watch = await started(r);
    append(r, reflogLine('2'.repeat(40)));
    watch.onChange('HEAD');
    await vi.advanceTimersByTimeAsync(200);
    // `reflog expire` rewrites it (a new file) right as a commit lands.
    const now = Math.floor(Date.now() / 1000);
    r.file = Object.assign(r.file, { ino: 2, bytes: Buffer.from(reflogLine('2'.repeat(40)) + `${OLD} ${'5'.repeat(40)} Dev <d@example.com> ${now} +0900\tcommit: z\n`) });
    watch.onChange('HEAD');
    await vi.advanceTimersByTimeAsync(200);
    expect(r.added.map((o) => o.sha[0])).toEqual(['2', '5']);
  });

  it('a watch that errors is armed again', async () => {
    const r = rig({}, ['p1']);
    const watch = await started(r);
    watch.onError();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.watches).toHaveLength(2);
    expect(r.watches[1].dir).toBe('/r/.git/logs');
  });
});
