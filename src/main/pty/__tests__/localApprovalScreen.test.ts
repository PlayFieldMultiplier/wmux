import { describe, expect, it, vi } from 'vitest';
import { createLocalApprovalScreenReader } from '../localApprovalScreen';
import { markResize, clearPty } from '../../notification/idleSuppression';

describe('local approval screen freshness', () => {
  function setup() {
    const pty = { process: { cols: 80, rows: 2 } };
    const window = { isDestroyed: () => false };
    const frame = { ptyId: 'p', approvalScreen: true, cols: 80, rowCount: 2, rows: ['Approve?', 'Yes / No'] };
    const deps = { getPty: vi.fn(() => pty), getWindow: vi.fn(() => window), read: vi.fn(async () => frame as unknown) };
    return { deps, pty, frame, read: createLocalApprovalScreenReader(deps) };
  }
  it('invalidates a parsed frame after resize or PTY replacement', async () => {
    const s = setup();
    const frame = await s.read('p');
    expect(frame?.isCurrent()).toBe(true);
    s.pty.process.rows++;
    expect(frame?.isCurrent()).toBe(false);
    s.pty.process.rows--;
    s.deps.getPty.mockReturnValue({ process: { cols: 80, rows: 2 } });
    expect(frame?.isCurrent()).toBe(false);
  });
  it('rejects a window replaced while awaiting its response', async () => {
    const s = setup();
    s.deps.read.mockImplementation(async () => {
      s.deps.getWindow.mockReturnValue({ isDestroyed: () => false });
      return s.frame;
    });
    expect(await s.read('p')).toBeNull();
  });
  it.each([
    { ptyId: 'other' }, { approvalScreen: false }, { cols: 100 }, { rowCount: 3 }, { rows: ['short'] }, { rows: ['one', null] },
  ])('rejects incomplete or mismatched response %j', async (change) => {
    const s = setup();
    s.deps.read.mockResolvedValue({ ...s.frame, ...change });
    expect(await s.read('p')).toBeNull();
  });
  it('rejects resize ABA even when dimensions return to their original values', async () => {
    const s = setup();
    s.deps.read.mockImplementation(async () => { markResize('p'); markResize('p'); return s.frame; });
    expect(await s.read('p')).toBeNull();
    clearPty('p');
  });
  it('fails closed on IPC errors', async () => {
    const s = setup();
    s.deps.read.mockRejectedValue(new Error('timeout'));
    expect(await s.read('p')).toBeNull();
  });
});
