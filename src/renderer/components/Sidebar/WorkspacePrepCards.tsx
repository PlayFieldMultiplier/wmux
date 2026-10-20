// The "Preparing" cards of worktrees a person opened (start from an issue,
// Quick Launch, the Git page): what the new workspace preparation is doing,
// and, when its setup fails, the last lines it printed with Retry and Start
// anyway. Main owns the cards (main/worktask/workspacePrepCards.ts); this
// draws them and sends the answer back.
//
// Renders only while a card is open: recovery chrome, not a standing surface.
// Shape first, colour second: a spinner while running, the red X for a
// failure, the caution mark for a skip; the rows themselves stay neutral.

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconCheck, IconWarning, IconX } from '../icons';
import Button from '../ui/Button';
import type { WorkspacePrepCard, WorkspacePrepDecision } from '../../../shared/workspacePrepCard';

/** Cards kept after main closed them: a skip or a gap the person should read. */
export function lingers(card: WorkspacePrepCard): boolean {
  return card.status === 'skipped' || card.suggestCopy !== undefined || (card.status === 'ready' && card.missing + card.refused > 0);
}

/** Fold one event into the list main's events describe. */
export function applyPrepCardEvent(cards: WorkspacePrepCard[], ev: WorkspacePrepCard): WorkspacePrepCard[] {
  const at = cards.findIndex((c) => c.id === ev.id);
  if (ev.status === 'closed') {
    if (at === -1) return cards;
    return lingers(cards[at]) ? cards : cards.filter((c) => c.id !== ev.id);
  }
  if (at === -1) return [...cards, ev];
  const next = cards.slice();
  next[at] = ev;
  return next;
}

/** `m:ss`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function WorkspacePrepCards() {
  const t = useT();
  const [cards, setCards] = useState<WorkspacePrepCard[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const api = window.electronAPI?.workspacePrep;

  useEffect(() => {
    if (!api) return;
    let live = true;
    const off = api.onCard((ev) => setCards((prev) => applyPrepCardEvent(prev, ev)));
    // A reload draws the cards that are still open.
    void api.list().then((open) => { if (live) setCards((prev) => open.reduce(applyPrepCardEvent, prev)); }, () => undefined);
    return () => { live = false; off(); };
  }, [api]);

  const ticking = cards.some((c) => c.status === 'running' && c.phase === 'setup');
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (cards.length === 0) return null;

  const decide = (id: string, d: WorkspacePrepDecision) => {
    void api?.decide(id, d).catch(() => undefined);
  };
  const forget = (id: string) => setCards((prev) => prev.filter((c) => c.id !== id));

  return (
    <div className="px-2 pb-1 space-y-0.5" data-testid="workspace-prep-cards" aria-live="polite">
      {cards.map((card) => {
        const copyLine = [
          card.copied > 0 ? t('prepCard.copied', { count: card.copied }) : null,
          card.missing > 0 ? t('prepCard.missing', { count: card.missing }) : null,
          card.refused > 0 ? t('prepCard.refused', { count: card.refused }) : null,
        ].filter(Boolean).join(', ');
        const setupLine = card.status === 'running' && card.phase === 'setup'
          ? t('prepCard.installing', {
              elapsed: clock(now - (card.setupStartedAt ?? now)),
              limit: clock(card.setupTimeoutMs ?? 300_000),
            })
          : null;
        const title =
          card.status === 'failed' ? t(card.timedOut ? 'prepCard.timedOut' : 'prepCard.failed')
            : card.status === 'skipped' ? t(card.reason === 'malformed' ? 'prepCard.skippedMalformed'
              : card.reason === 'needs-review' ? 'prepCard.skippedReview' : 'prepCard.skipped')
              : card.status === 'ready' ? t('prepCard.ready')
                : t('prepCard.preparing');
        return (
          <div key={card.id} className="rounded-[10px] px-2 py-1.5" data-testid="workspace-prep-card" data-status={card.status}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 pt-[3px]" aria-hidden="true">
                {card.status === 'running' && <span className="inline-block w-3 h-3 rounded-full border border-[var(--text-muted)] border-t-transparent motion-safe:animate-spin" />}
                {card.status === 'failed' && <span style={{ color: 'var(--accent-red)' }}><IconX size={12} /></span>}
                {card.status === 'skipped' && <span style={{ color: 'var(--accent-yellow)' }}><IconWarning size={12} /></span>}
                {card.status === 'ready' && <span className="text-[var(--text-muted)]"><IconCheck size={12} /></span>}
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px] font-medium text-[var(--text-main)] truncate">{title} · {card.title}</p>
                {(copyLine || setupLine) && (
                  <p className="m-0 text-[13px] text-[var(--text-sub)]">{[copyLine, setupLine].filter(Boolean).join(', ')}</p>
                )}
                {card.status === 'failed' && card.outputTail && card.outputTail.length > 0 && (
                  <pre className="ui-code m-0 mt-1 max-h-[96px] overflow-auto whitespace-pre-wrap break-all text-[11px] text-[var(--text-sub)]" data-testid="workspace-prep-tail">
                    {card.outputTail.slice(-6).join('\n')}
                  </pre>
                )}
                {card.status === 'failed' && (
                  <div className="flex gap-1.5 mt-1.5">
                    <Button size="sm" variant="secondary" onClick={() => decide(card.id, 'retry')}>{t('prepCard.retry')}</Button>
                    {card.startsAgent && (
                      <Button size="sm" variant="secondary" onClick={() => decide(card.id, 'start')}>{t('prepCard.startAnyway')}</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => decide(card.id, 'dismiss')}>{t('prepCard.dismiss')}</Button>
                  </div>
                )}
                {card.suggestCopy && card.status !== 'running' && (
                  <p className="m-0 mt-1 text-[13px] text-[var(--text-sub)]" data-testid="workspace-prep-suggest">
                    {t('prepCard.suggestCopy', { count: card.suggestCopy.count })}
                  </p>
                )}
                {lingers(card) && card.status !== 'running' && card.status !== 'failed' && (
                  <div className="flex gap-1.5 mt-1.5">
                    {card.suggestCopy && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          const cwd = card.suggestCopy?.cwd;
                          forget(card.id);
                          if (cwd) useStore.getState().setPrepDialogCwd(cwd);
                        }}
                      >
                        {t('prepCard.suggestAction')}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => forget(card.id)}>{t('prepCard.dismiss')}</Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
