// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { useAgentActivityClock } from '../useAgentActivityClock';

function Clock() {
  useAgentActivityClock();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useAgentActivityClock', () => {
  it('keeps moving while a live agent printed lately, so the sleep verdict can expire', () => {
    const now = Date.now();
    useStore.setState({
      surfaceActivityAt: {}, surfaceTurnOpenAt: {}, surfaceTeammatesAt: {}, surfaceSubagentsAt: {},
      agentAliveByPtyId: { 'pty-1': true }, surfaceOutputAt: { 'pty-1': now }, agentClockMs: now - 60_000,
    });
    act(() => root.render(<Clock />));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(useStore.getState().agentClockMs).toBeGreaterThanOrEqual(now);

    // A shell that printed (no live agent) leaves the clock at rest.
    useStore.setState({ agentAliveByPtyId: {}, agentClockMs: 0 });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(useStore.getState().agentClockMs).toBe(0);
  });
});
