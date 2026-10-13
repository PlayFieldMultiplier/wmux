// An in-place confirm for a destructive step on the Bots page (never a
// window dialog): what will happen, Cancel, and the final confirm — the one
// place the solid red button is drawn (DESIGN.md › Buttons). The confirm
// takes focus, so Enter confirms and Escape cancels.
import { useEffect, useRef } from 'react';
import Button from '../ui/Button';

export function InlineConfirm({ text, confirmLabel, cancelLabel, busy, onConfirm, onCancel, testId }: {
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Prefix for the parts' test ids (`<id>-confirm`, `<id>-cancel`). */
  testId: string;
}): React.ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  return (
    <div
      role="group"
      aria-label={text}
      data-testid={`${testId}-confirm-row`}
      className="flex flex-col gap-1.5"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <p className="text-[12px] leading-snug text-[var(--text-sub)]">{text}</p>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" data-testid={`${testId}-cancel`} disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
        <Button ref={confirmRef} size="sm" variant="danger" data-testid={`${testId}-confirm`} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  );
}
