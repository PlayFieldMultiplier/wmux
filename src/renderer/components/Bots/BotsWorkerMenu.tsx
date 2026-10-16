// ─── A bot worker's ⋯ menu, and its Stop worker confirm ──────────────────
//
// One menu for a worker, on its row in the list (BotsWorkerTree) and in the
// worker panel's header (BotsWorkerPanel): Resume for an ended task that can
// resume (the panel's), Open in Workspaces, and Stop worker for a live worker
// whose task is still open. Stop worker asks in place first (InlineConfirm,
// as the profile's Stop does); it stops that one task's worker — its task is
// cancelled ("stopped by owner"), the bot's turn and its other work go on —
// and says what it did in a toast.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import Popover from '../ui/Popover';
import { FOCUS_RING } from '../focusRing';
import { IconMoreHorizontal } from '../icons';
import { InlineConfirm } from './InlineConfirm';
import { stopTaskSummary, type BotsStopPort } from './botsStop';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The ⋯ button and its menu. `attr` names the parts' data attributes
 *  (`<attr>-menu`, `-resume`, `-workspaces`, `-stop`). */
export function WorkerMenu({ attr, t, wrapClassName = '', buttonClassName, iconSize = 14, onOpenInWorkspaces, onResume, onStop }: {
  attr: 'data-bots-worker-panel' | 'data-bots-worker';
  t: T;
  wrapClassName?: string;
  buttonClassName: string;
  iconSize?: number;
  onOpenInWorkspaces: () => void;
  onResume?: () => void;
  onStop?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  // The menu's keys: arrows, Home and End move between the items; the
  // first is focused when it opens.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length
      : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  };
  const item = `ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`;
  return (
    <span ref={wrapRef} className={`relative inline-flex ${wrapClassName} ${open ? 'is-open' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        {...{ [`${attr}-menu`]: '' }}
        aria-label={t('botsPage.worker.menu')}
        title={t('botsPage.worker.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${buttonClassName} ${open ? 'is-open' : ''} ${FOCUS_RING}`}
      >
        <IconMoreHorizontal size={iconSize} />
      </button>
      {open && (
        <Popover
          ref={menuRef}
          role="menu"
          aria-label={t('botsPage.worker.menu')}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px]"
          onKeyDown={onMenuKey}
        >
          {onResume && (
            <button type="button" role="menuitem" {...{ [`${attr}-resume`]: '' }} onClick={() => { close(); onResume(); }} className={item}>
              {t('botsPage.worker.resume')}
            </button>
          )}
          <button type="button" role="menuitem" {...{ [`${attr}-workspaces`]: '' }} onClick={() => { close(); onOpenInWorkspaces(); }} className={item}>
            {t('botsPage.chat.openInWorkspaces')}
          </button>
          {onStop && (
            <button
              type="button"
              role="menuitem"
              {...{ [`${attr}-stop`]: '' }}
              onClick={() => { close(); onStop(); }}
              className={`${item} text-[var(--accent-red)]`}
            >
              {t('botsPage.worker.stop')}
            </button>
          )}
        </Popover>
      )}
    </span>
  );
}

/** Stop worker's in-place confirm: what will happen, Cancel and Stop. The
 *  result is a toast; a stop that went through closes it. */
export function WorkerStopConfirm({ task, taskId, stopTask, t, testId, onClose }: {
  /** The worker's task, by its title. */
  task: string;
  taskId: string;
  stopTask: NonNullable<BotsStopPort['stopTask']>;
  t: T;
  testId: string;
  onClose: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await stopTask(taskId);
      useStore.getState().pushToast({ message: stopTaskSummary(task, r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) onClose();
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <InlineConfirm
      text={t('botsPage.stop.workerConfirm', { task })}
      confirmLabel={t('botsPage.stop.bot')}
      cancelLabel={t('room.hq.cancel')}
      busy={busy}
      onConfirm={() => void run()}
      onCancel={onClose}
      testId={testId}
    />
  );
}
