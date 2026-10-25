// @vitest-environment jsdom
// The stuck-turn chip: drawn only while the daemon reads the turn as stuck,
// its card's Keep waiting and Stop and prefill reach the daemon, and a stop
// that fails keeps the card open with a line.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import AgentStallChip from '../AgentStallChip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const keepWaiting = vi.fn(async () => ({ ok: true }));
const stopAndPrefill = vi.fn(async () => ({ result: 'filled' }));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('electronAPI', { agentStall: { keepWaiting, stopAndPrefill } });
  useStore.setState({ surfaceStalledAt: {} } as never);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  keepWaiting.mockClear();
  stopAndPrefill.mockClear();
});

const chip = () => container.querySelector('[data-agent-stall-action="card"]') as HTMLButtonElement | null;
const action = (name: string) => document.body.querySelector(`[data-agent-stall-action="${name}"]`) as HTMLButtonElement | null;

describe('AgentStallChip', () => {
  it('shows only while the turn reads as stuck, and Keep waiting reaches the daemon', async () => {
    act(() => root.render(<AgentStallChip ptyId="pty-1" />));
    expect(chip()).toBeNull();
    act(() => useStore.setState({ surfaceStalledAt: { 'pty-1': Date.now() - 4 * 60_000 } } as never));
    expect(chip()?.textContent).toBe('Seems stuck');
    expect(chip()?.title).toContain('4 min');
    act(() => chip()!.click());
    await act(async () => { action('wait')!.click(); });
    expect(keepWaiting).toHaveBeenCalledWith('pty-1');
    expect(document.body.querySelector('[data-agent-stall-card]')).toBeNull();
    act(() => useStore.setState({ surfaceStalledAt: {} } as never));
    expect(chip()).toBeNull();
  });

  it('Stop and prefill closes the card when done, and keeps it open with a line when the stop fails', async () => {
    useStore.setState({ surfaceStalledAt: { 'pty-1': Date.now() - 4 * 60_000 } } as never);
    act(() => root.render(<AgentStallChip ptyId="pty-1" />));
    act(() => chip()!.click());
    stopAndPrefill.mockResolvedValueOnce({ result: 'blocked' });
    await act(async () => { action('prefill')!.click(); });
    expect(stopAndPrefill).toHaveBeenCalledWith('pty-1');
    expect(document.body.querySelector('[data-agent-stall-failed]')).not.toBeNull();
    await act(async () => { action('prefill')!.click(); });
    expect(document.body.querySelector('[data-agent-stall-card]')).toBeNull();
  });
});
