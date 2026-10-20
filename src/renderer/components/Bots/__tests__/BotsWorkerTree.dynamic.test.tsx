// @vitest-environment jsdom
//
// A reported non-code task's row in a bot's worker tree shows the evidence
// grade the rail shows (#2461): the same words and data attribute, nothing
// once every item is verified.
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import BotsWorkerTree, { treeRowLabel } from '../BotsWorkerTree';
import type { BotTreeRow } from '../botsModel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mount(rows: BotTreeRow[]) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<BotsWorkerTree id="tree" rows={rows} name="Lead" shownId={null} t={t} onOpen={() => undefined} />));
  cleanups.push(() => { act(() => root.unmount()); el.remove(); });
  return el;
}

const row = (workspaceId: string, verification?: BotTreeRow['verification']): BotTreeRow => ({
  workspaceId, title: `task ${workspaceId}`, state: 'review', taskId: workspaceId, resumable: false, ...(verification ? { verification } : {}),
});

describe('BotsWorkerTree evidence grade', () => {
  it('missing and partial evidence show the rail\'s words; verified evidence and a code task show none', () => {
    const el = mount([
      row('t1', { state: 'missing', verified: 0, total: 0 }),
      row('t2', { state: 'partial', verified: 1, total: 2 }),
      row('t3', { state: 'verified', verified: 2, total: 2 }),
      row('t4'),
    ]);
    const mark = (id: string) => el.querySelector(`[data-bots-worker="${id}"] [data-bots-task-verification]`);
    expect(mark('t1')?.getAttribute('data-bots-task-verification')).toBe('missing');
    expect(mark('t1')?.textContent).toBe('botsPage.task.notVerified(0,0)');
    expect(mark('t2')?.getAttribute('data-bots-task-verification')).toBe('partial');
    expect(mark('t2')?.textContent).toBe('botsPage.task.evidencePartial(1,2)');
    expect(mark('t3')).toBeNull();
    expect(mark('t4')).toBeNull();
    // The row's accessible name says it too.
    expect(el.querySelector('[data-bots-worker="t2"]')?.getAttribute('aria-label')).toBe('task t2, botsPage.worker.inReview · botsPage.task.evidencePartial(1,2)');
  });

  it('the row label carries the grade after its folder note', () => {
    expect(treeRowLabel({ ...row('t1', { state: 'unverified', verified: 0, total: 2 }), folderKept: true }, t))
      .toBe('botsPage.worker.inReview · botsPage.worker.folderKept · botsPage.task.notVerified(0,2)');
    expect(treeRowLabel(row('t1', { state: 'verified', verified: 2, total: 2 }), t)).toBe('botsPage.worker.inReview');
  });
});
