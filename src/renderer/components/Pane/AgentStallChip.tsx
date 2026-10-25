// Pane-header chip for a Claude turn the daemon reads as stuck (StallWatch).
// Lives in the tab strip's flow beside the usage-limit chip, and shows only
// while the stall lasts: the word "Seems stuck" in the caution colour, nothing
// else coloured. It opens a small card with Stop and prefill (interrupt, then
// put the last prompt back into the input, unsent) and Keep waiting (ask again
// only after twice as long, for this turn). Nothing is ever stopped by itself.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { placePopover } from '../AgentToolbar/placePopover';
import Popover, { PopoverSection } from '../ui/Popover';
import Button from '../ui/Button';
import { useUsageLimitNow } from './UsageLimitChip';
import type { StallPrefillResult } from '../../../shared/types';

export const AGENT_STALL_CARD_WIDTH = 280;

type Anchor = { top: number; left: number; right: number; bottom: number };

/** Whole minutes without progress, at least 1. */
export function stallMinutes(since: number, now: number): number {
  return Math.max(1, Math.floor((now - since) / 60_000));
}

/** Results after which the card's job is done; anything else (the daemon
 *  refused the stop) keeps it open with a line. */
const DONE: ReadonlySet<StallPrefillResult> = new Set(['filled', 'kept', 'stopped']);

export function AgentStallCard({ ptyId, minutes, anchor, triggerRef, onClose }: {
  ptyId: string;
  minutes: number;
  anchor: Anchor;
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(140);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    // Capture on keydown: the terminal swallows keys.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  const api = window.electronAPI?.agentStall;
  const pos = placePopover(anchor, { width: AGENT_STALL_CARD_WIDTH, height });
  const stopAndPrefill = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailed(false);
    const { result } = await api.stopAndPrefill(ptyId).catch(() => ({ result: 'error' as const }));
    setBusy(false);
    if (DONE.has(result)) onClose();
    else setFailed(true);
  };

  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={t('agentStall.cardTitle')}
      data-agent-stall-card
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: AGENT_STALL_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <PopoverSection title={t('agentStall.cardTitle')}>
        <p className="text-[12px] text-[var(--text-sub)]">{t('agentStall.cardBody', { minutes })}</p>
        {failed && <p className="mt-1 text-[12px] text-[var(--text-sub)]" role="status" data-agent-stall-failed>{t('agentStall.failed')}</p>}
        <div className="mt-2 flex flex-col gap-1">
          <Button
            size="sm"
            className="justify-start"
            disabled={!api || busy}
            title={t('agentStall.stopAndPrefillTitle')}
            onClick={() => { void stopAndPrefill(); }}
            data-agent-stall-action="prefill"
          >
            {t('agentStall.stopAndPrefill')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            disabled={!api || busy}
            title={t('agentStall.keepWaitingTitle')}
            onClick={() => { void api?.keepWaiting(ptyId).catch(() => undefined); onClose(); }}
            data-agent-stall-action="wait"
          >
            {t('agentStall.keepWaiting')}
          </Button>
        </div>
      </PopoverSection>
    </Popover>,
    document.body,
  );
}

export default function AgentStallChip({ ptyId, readOnly = false }: {
  ptyId: string | undefined;
  readOnly?: boolean;
}) {
  const t = useT();
  const since = useStore((s) => (ptyId ? s.surfaceStalledAt[ptyId] : undefined));
  const now = useUsageLimitNow(since !== undefined);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // The card belongs to one stall: it goes when the stall clears.
  useEffect(() => { if (since === undefined) setAnchor(null); }, [since]);
  if (since === undefined || !ptyId) return null;
  const minutes = stallMinutes(since, now);
  const title = t('agentStall.chipTitle', { minutes });
  const word = <span className="truncate text-[var(--accent-yellow)]" aria-hidden="true">{t('agentStall.label')}</span>;
  return (
    <span
      data-pane-agent-stall
      className="shrink min-w-0 overflow-hidden flex items-center text-[11px] text-[var(--text-muted)] select-none"
      onClick={(e) => e.stopPropagation()}
    >
      {readOnly ? (
        <span className="flex items-center min-w-0 px-1" title={title} aria-label={title} role="img">{word}</span>
      ) : (
        <button
          ref={btnRef}
          type="button"
          className={`${FOCUS_RING} flex items-center min-w-0 px-1 h-6 rounded-[var(--chip-radius)] hover:bg-[var(--selection-hover)] hover:[--text-muted:var(--text-subtle)]`}
          title={title}
          aria-label={`${t('agentStall.openCard')}: ${title}`}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          onClick={(e) => {
            if (anchor) { setAnchor(null); return; }
            setAnchor(e.currentTarget.getBoundingClientRect());
          }}
          data-agent-stall-action="card"
        >
          {word}
        </button>
      )}
      {anchor && !readOnly && (
        <AgentStallCard ptyId={ptyId} minutes={minutes} anchor={anchor} triggerRef={btnRef} onClose={() => setAnchor(null)} />
      )}
    </span>
  );
}
