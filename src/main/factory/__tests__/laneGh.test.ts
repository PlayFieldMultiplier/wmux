// laneGh.squashMergeEffect: the executor's gate reaches the GitHub merge, so
// the merge asks it right before it writes.
import { describe, expect, it, vi } from 'vitest';

const merge = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../../github/GhPrReviewService', () => ({
  ghPrReviewService: {
    checks: vi.fn(async () => ({ ok: true, value: { head: { title: 'feat: x' } } })),
    merge: (...args: unknown[]) => merge(...args),
  },
}));
vi.mock('../../deck/taskLedgerHost', () => ({ getTaskLedger: vi.fn() }));
vi.mock('../../workspace/WorkspaceMirror', () => ({ getWorkspaceMirror: vi.fn() }));

import { squashMergeEffect } from '../laneGh';

describe('squashMergeEffect', () => {
  it('hands the executor gate to the merge', async () => {
    const gate = (): string | null => 'revoked';
    const effect = { repoPath: '/r', repoKey: 'github.com/a/b', prNumber: 7, expectHead: 'a'.repeat(40) };
    await squashMergeEffect(effect as never, gate);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][0]).toBe('/r');
    expect(merge.mock.calls[0][3]).toMatchObject({ expectHead: 'a'.repeat(40), subject: 'feat: x (#7)', body: '' });
    expect(merge.mock.calls[0][4]).toBe(gate);
  });
});
