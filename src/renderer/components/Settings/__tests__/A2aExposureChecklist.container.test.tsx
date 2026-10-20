// @vitest-environment jsdom
//
// The checklist container: nothing is tickable until the saved exposure is
// read, and writes run one after another on the latest saved value, so two
// quick ticks never overwrite each other.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { A2aExposureV1 } from '../../../../shared/a2aRemote';
import { useStore } from '../../../stores';
import { A2aExposureChecklist } from '../A2aExposureChecklist';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const HOST = '11111111-1111-4111-8111-111111111111';
const t = (k: string): string => k;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const rec = (workspaceIds: string[], paneIds: Record<string, string[]>): A2aExposureV1 => ({ v: 1, hostId: HOST, workspaceIds, paneIds, updatedAt: '' });

describe('A2aExposureChecklist', () => {
  it('waits for the saved exposure, then writes each tick on top of the last', async () => {
    let release!: (v: { exposure: A2aExposureV1 }) => void;
    const sets: Array<[string[], Record<string, string[]>]> = [];
    // The daemon's copy: the first read waits; later reads answer what is saved now.
    let saved: A2aExposureV1 | null = null;
    let first = true;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      a2aRemote: {
        exposureGet: vi.fn(() => {
          if (!first) return Promise.resolve({ exposure: saved });
          first = false;
          return new Promise((r) => { release = (v) => { saved = v.exposure; r(v); }; });
        }),
        exposureSet: vi.fn(async (_h: string, ws: string[], panes: Record<string, string[]>) => {
          sets.push([ws, panes]);
          saved = rec(ws, panes);
          return { exposure: saved };
        }),
      },
    };
    act(() => {
      useStore.setState({
        workspaces: [{
          id: 'w1', name: 'API', activePaneId: 'a',
          rootPane: { id: 'b0', type: 'branch', direction: 'horizontal', children: [
            { id: 'a', type: 'leaf', surfaces: [], activeSurfaceId: '' },
            { id: 'b', type: 'leaf', surfaces: [], activeSurfaceId: '' },
          ] },
        }],
      } as never);
    });
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => root!.render(createElement(A2aExposureChecklist, { hostId: HOST, pcName: 'LAPTOP', t })));
    const box = (paneId: string): HTMLButtonElement => el.querySelector(`[data-pane-id="${paneId}"] [role="checkbox"]`)!;
    expect(box('a').disabled).toBe(true);

    await act(async () => release({ exposure: rec(['w1'], { w1: ['b'] }) }));
    expect(box('a').disabled).toBe(false);
    await act(async () => { box('a').click(); });
    expect(sets).toEqual([[['w1'], { w1: ['b', 'a'] }]]);

    // A share shows another pane meanwhile: the next tick keeps it.
    saved = rec(['w1'], { w1: ['b', 'a', 'c'] });
    await act(async () => { box('b').click(); });
    expect(sets.at(-1)).toEqual([['w1'], { w1: ['a', 'c'] }]);
  });

  it('a save the daemon refuses because a share changed the list is made again on the new list; a failed read saves nothing', async () => {
    const sets: Array<[string[], Record<string, string[]>]> = [];
    let saved: A2aExposureV1 | null = rec(['w1'], { w1: ['b'] });
    let reads = 0;
    let readFails = false;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      a2aRemote: {
        exposureGet: vi.fn(async () => {
          reads++;
          if (readFails) throw new Error('daemon gone');
          const answer = { exposure: saved };
          // The second read races a share of pane c, landing before the save.
          if (reads === 2) saved = rec(['w1'], { w1: ['b', 'c'] });
          return answer;
        }),
        exposureSet: vi.fn(async (_h: string, ws: string[], panes: Record<string, string[]>, _b: boolean, expected?: A2aExposureV1 | null) => {
          if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(saved)) return { exposure: saved, conflict: true };
          sets.push([ws, panes]);
          saved = rec(ws, panes);
          return { exposure: saved };
        }),
      },
    };
    act(() => {
      useStore.setState({
        workspaces: [{
          id: 'w1', name: 'API', activePaneId: 'a',
          rootPane: { id: 'b0', type: 'branch', direction: 'horizontal', children: [
            { id: 'a', type: 'leaf', surfaces: [], activeSurfaceId: '' },
            { id: 'b', type: 'leaf', surfaces: [], activeSurfaceId: '' },
          ] },
        }],
      } as never);
    });
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(A2aExposureChecklist, { hostId: HOST, pcName: 'LAPTOP', t })));
    const box = (paneId: string): HTMLButtonElement => el.querySelector(`[data-pane-id="${paneId}"] [role="checkbox"]`)!;
    await act(async () => { box('a').click(); });
    expect(sets).toEqual([[['w1'], { w1: ['b', 'c', 'a'] }]]);

    readFails = true;
    await act(async () => { box('b').click(); });
    expect(sets).toHaveLength(1);
  });
});
