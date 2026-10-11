// The review order guide of a PR Moa delivered from this computer (main only
// sends one for a verified Moa PR; shared/prReviewGuide.ts), as a stepper on
// the PR detail pane: Next scrolls to where each step's proof lives, each
// step is marked checked, and Approve is highlighted only once the required
// steps are checked AND the gate passed on the commit on screen AND every CI
// check is green. Checks are kept for the session per PR and head.
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import type { ReviewGuide, ReviewGuideTarget } from '../../../shared/prReviewGuide';
import type { PrCheck } from '../../../shared/prReview';

const checkedBy = new Map<string, ReadonlySet<number>>();

/** Tests only. */
export function resetReviewGuideChecks(): void {
  checkedBy.clear();
}

export function guideKey(repoPath: string, number: number, head: string): string {
  return `${repoPath}\0${number}\0${head}`;
}

const TARGET_SELECTOR: Record<ReviewGuideTarget, string | null> = {
  criteria: null,
  evidence: '[data-pr-checks]',
  files: '[data-pr-files]',
};

/** Every CI check finished green (none failing, cancelled or still running). */
export function ciGreen(checks: readonly PrCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.bucket === 'pass' || c.bucket === 'skipping');
}

/** Why Approve is not highlighted yet, or null when it is ready. */
export function approveBlock(key: string, guide: ReviewGuide, head: string, checks: readonly PrCheck[]): 'moved' | 'gate' | 'ci' | 'steps' | null {
  if (head !== guide.headSha) return 'moved';
  if (guide.gate !== 'passed') return 'gate';
  if (!ciGreen(checks)) return 'ci';
  const c = checkedBy.get(key);
  return guide.steps.every((s, i) => s.target === 'files' || c?.has(i)) ? null : 'steps';
}

export function PrReviewGuide({ guide, guideKey: key, head, checks, onChange }: {
  guide: ReviewGuide;
  guideKey: string;
  /** The head on screen. */
  head: string;
  checks: readonly PrCheck[];
  onChange: () => void;
}): React.ReactElement {
  const t = useT();
  const [current, setCurrent] = useState(0);
  const [, bump] = useState(0);
  const steps = guide.steps;
  const checked = checkedBy.get(key) ?? new Set<number>();
  const done = steps.filter((_, i) => checked.has(i)).length;
  const block = approveBlock(key, guide, head, checks);

  const go = (i: number, from: HTMLElement) => {
    setCurrent(i);
    const pane = from.closest('[data-pr-detail]');
    const sel = TARGET_SELECTOR[steps[i].target];
    const el = (sel && pane?.querySelector(sel)) || pane?.querySelector(`[data-guide-step="${i}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const toggle = (i: number) => {
    const next = new Set(checked);
    if (next.has(i)) next.delete(i); else next.add(i);
    checkedBy.set(key, next);
    bump((n) => n + 1);
    onChange();
  };

  return (
    <section className="wmux-git-section" aria-label={t('git.guide.title')} data-pr-guide>
      <h3 className="wmux-git-section-title">{t('git.guide.title')}</h3>
      <ol className="wmux-git-guide">
        {steps.map((s, i) => (
          <li
            key={i}
            className={i === current ? 'wmux-git-guide-step wmux-git-guide-current' : 'wmux-git-guide-step'}
            aria-current={i === current ? 'step' : undefined}
            data-guide-step={i}
            data-guide-target={s.target}
          >
            <label className="wmux-git-field">
              <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} data-guide-check={i} />
              <span className="font-medium">{t(`git.guide.step.${s.target}`)}</span>
              {checked.has(i) && <span className="wmux-git-note" data-guide-checked={i}>{t('git.guide.checked')}</span>}
            </label>
            <div className="wmux-git-note">{t(`git.guide.hint.${s.target}`)}</div>
            {s.target === 'evidence' && (
              <div className={guide.gate === 'passed' ? 'wmux-git-note' : 'wmux-git-ship-error'} data-guide-gate={guide.gate}>
                {t(`git.guide.gate.${guide.gate}`, { sha: guide.headSha.slice(0, 7) })}
              </div>
            )}
            {i === current && s.items.length > 0 && (
              <ul className="wmux-git-guide-items">
                {s.items.map((item, j) => <li key={j}><code>{item}</code></li>)}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <div className="wmux-git-review-actions">
        <span className="wmux-git-note" data-guide-progress>{t('git.guide.progress', { done, total: steps.length })}</span>
        <button
          type="button"
          className={`wmux-git-button ${FOCUS_RING}`}
          onClick={(e) => go((current + 1) % steps.length, e.currentTarget)}
          data-guide-next
        >
          {t('git.guide.next')}
        </button>
      </div>
      {block === null
        ? <div className="wmux-git-note" role="status" data-guide-done>{t('git.guide.allChecked')}</div>
        : block !== 'steps' && <div className="wmux-git-ship-reason" role="status" data-guide-block={block}>{t(`git.guide.block.${block}`)}</div>}
    </section>
  );
}

/** A body that claims a guide on a PR that is not a verified Moa PR. */
export function PrReviewGuideUnverified(): React.ReactElement {
  const t = useT();
  return <div className="wmux-git-ship-reason" role="status" data-pr-guide-unverified>{t('git.guide.unverified')}</div>;
}
