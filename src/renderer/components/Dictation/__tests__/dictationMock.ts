// A stand-in for renderer/dictation/dictation.ts in UI tests: its state is set
// by the test, and every action is a spy. Use it as the module mock:
//   vi.mock('<path>/dictation/dictation', () => import('<path>/dictationMock'));
import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';
import type { DictationState } from '../../../dictation/dictation';

let state: DictationState = { phase: 'idle', target: null, model: { state: 'absent' }, startedAt: null, error: null };
const listeners = new Set<() => void>();

/** Change what useDictation reports (wrap in act()). */
export function setDictation(patch: Partial<DictationState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function resetDictationMock(): void {
  state = { phase: 'idle', target: null, model: { state: 'absent' }, startedAt: null, error: null };
  for (const fn of [toggleDictation, acceptModelDownload, declineModelDownload, cancelModelDownload, stopDictation, cancelDictation, clearDictationError]) fn.mockClear();
}

export function useDictation(): DictationState {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => state);
}
export const getDictationState = (): DictationState => state;
export const toggleDictation = vi.fn<(target: string, onText: (text: string) => void) => Promise<void>>(async () => undefined);
export const acceptModelDownload = vi.fn(async () => undefined);
export const declineModelDownload = vi.fn();
export const cancelModelDownload = vi.fn();
export const stopDictation = vi.fn(async () => undefined);
export const cancelDictation = vi.fn();
export const clearDictationError = vi.fn();
