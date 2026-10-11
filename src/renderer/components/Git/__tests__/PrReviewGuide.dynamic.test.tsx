// @vitest-environment jsdom
//
// The review order guide on the PR detail pane: read from the PR body, walked
// with Next to where each step's proof lives, each step checked, Approve
// highlighted only once all are — and a new head starts the walk over.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { resetReviewGuideChecks } from '../PrReviewGuide';
import { useStore } from '../../../stores';
import type { PrSummary } from '../../../../shared/prSurface';
import type { PrReviewHead } from '../../../../shared/prReview';
import type { ReviewGuide } from '../../../../shared/prReviewGuide';
import type { PrCheck } from '../../../../shared/prReview';

const A = 'a'.repeat(40);
const pr: PrSummary = {
  number: 7, title: 'Moa: fix a', state: 'open', author: 'moa', headRefName: 'wtask/fix-a', updatedAt: 'u',
  url: 'https://github.com/o/r/pull/7', reviewDecision: '', checks: null, mergeable: '',
};
const head: PrReviewHead = {
  number: 7, title: 'Moa: fix a', url: pr.url, state: 'OPEN', isDraft: false, headRefOid: A,
  headRefName: 'wtask/fix-a', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
};
const guideOf = (gate: ReviewGuide['gate'] = 'passed', headSha = A): ReviewGuide => ({
  steps: [
    { target: 'criteria', items: ['(1) a.txt says fixed'] },
    { target: 'evidence', items: ['`npm test`'] },
    { target: 'files', items: [] },
  ],
  gate,
  headSha,
});
const guide = guideOf();
const check = (bucket: PrCheck['bucket']): PrCheck => ({ name: 'ci', workflow: 'ci', bucket, link: 'l' });

let container: HTMLDivElement;
let root: Root;
let scrolled: string[];

function bridge(reviewGuide?: ReviewGuide, opts: { unverified?: boolean; checks?: PrCheck[] } = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    github: {
      prList: vi.fn(),
      prDetail: vi.fn(async () => ({ ok: true, detail: { number: 7, comments: [], ...(reviewGuide ? { reviewGuide } : {}), ...(opts.unverified ? { reviewGuideUnverified: true } : {}) } })),
      prChecks: vi.fn(async () => ({ ok: true, value: { head, checks: opts.checks ?? [check('pass')] } })),
      prFiles: vi.fn(async () => ({ ok: true, value: { headRefOid: A, files: [], truncated: false } })),
      prThreads: vi.fn(async () => ({ ok: true, value: { threads: [], truncated: false } })),
      prSubmitReview: vi.fn(async () => ({ ok: true })), prMerge: vi.fn(async () => ({ ok: true })),
      prRunLog: vi.fn(), prRerunFailed: vi.fn(),
    },
  };
}

beforeEach(() => {
  resetReviewGuideChecks();
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.hasAttribute('data-pr-checks') ? 'checks' : this.hasAttribute('data-pr-files') ? 'files' : `step${this.getAttribute('data-guide-step')}`);
  } as never;
  act(() => useStore.setState({ appRoute: 'git' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const click = (el: HTMLElement | null) => act(() => { el!.click(); });
const render = async () => { act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr }))); await flush(); };

describe('PR review order guide', () => {
  it('is absent when the PR body has no guide', async () => {
    bridge();
    await render();
    expect(q('[data-pr-guide]')).toBeNull();
    expect(q('[data-pr-approve-ready]')).toBeNull();
  });

  it('steps with Next to each location, and highlights Approve once every step is checked', async () => {
    bridge(guide);
    await render();
    expect(q('[data-pr-guide]')).not.toBeNull();
    expect(q('[data-guide-step="0"]')!.getAttribute('aria-current')).toBe('step');
    expect(q('[data-guide-step="0"]')!.textContent).toContain('(1) a.txt says fixed');

    click(q('[data-guide-next]'));
    expect(q('[data-guide-step="1"]')!.getAttribute('aria-current')).toBe('step');
    click(q('[data-guide-next]'));
    click(q('[data-guide-next]'));
    expect(scrolled).toEqual(['checks', 'files', 'step0']);

    const approve = () => q('[data-pr-review-event="APPROVE"]')!;
    click(q('[data-guide-check="0"]'));
    expect(approve().hasAttribute('data-pr-approve-ready')).toBe(false);
    expect(q('[data-guide-done]')).toBeNull();
    // The code step is optional: what was asked + proof is enough.
    click(q('[data-guide-check="1"]'));
    expect(approve().hasAttribute('data-pr-approve-ready')).toBe(true);
    expect(approve().className).toContain('wmux-git-approve-ready');
    expect(q('[data-guide-done]')).not.toBeNull();
    expect(q('[data-guide-progress]')!.textContent).toContain('2');

    click(q('[data-guide-check="1"]'));
    expect(approve().hasAttribute('data-pr-approve-ready')).toBe(false);
  });

  const checkAll = () => { for (const i of [0, 1, 2]) click(q(`[data-guide-check="${i}"]`)); };

  it('a PR whose body claims a guide but is not a verified Moa PR shows only the warning', async () => {
    bridge(undefined, { unverified: true });
    await render();
    expect(q('[data-pr-guide]')).toBeNull();
    expect(q('[data-pr-guide-unverified]')).not.toBeNull();
    expect(q('[data-pr-approve-ready]')).toBeNull();
  });

  it('a missing gate result says Not verified and never highlights Approve', async () => {
    bridge(guideOf('missing'));
    await render();
    expect(q('[data-guide-gate="missing"]')!.textContent).toContain('Not verified');
    checkAll();
    expect(q('[data-pr-approve-ready]')).toBeNull();
    expect(q('[data-guide-block="gate"]')).not.toBeNull();
  });

  it.each([['fail'], ['pending'], ['cancel']] as const)('CI %s keeps Approve plain even with every step checked', async (bucket) => {
    bridge(guide, { checks: [check('pass'), check(bucket)] });
    await render();
    checkAll();
    expect(q('[data-pr-approve-ready]')).toBeNull();
    expect(q('[data-guide-block="ci"]')).not.toBeNull();
  });

  it('no CI checks at all is not green', async () => {
    bridge(guide, { checks: [] });
    await render();
    checkAll();
    expect(q('[data-pr-approve-ready]')).toBeNull();
  });

  it('a head other than the one Moa verified is never ready', async () => {
    bridge(guideOf('passed', 'c'.repeat(40)));
    await render();
    checkAll();
    expect(q('[data-pr-approve-ready]')).toBeNull();
    expect(q('[data-guide-block="moved"]')).not.toBeNull();
  });

  it('keeps the checks when the pane is opened again for the same head', async () => {
    bridge(guide);
    await render();
    for (const i of [0, 1]) click(q(`[data-guide-check="${i}"]`));
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(q('[data-pr-approve-ready]')).not.toBeNull();
  });
});
