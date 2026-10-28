// ─── Settings layout: section, row, note ─────────────────────────────────────
//
// DESIGN.md "Settings": a section is a muted sentence-case heading over ONE
// rounded container; its rows are Field rows separated by hairlines, never a
// boxed card per row. A long explanation collapses to one line with an info
// button that shows the rest instead of a four-line paragraph. `id` (a catalog id) makes
// a section or row a jump target for settings search — SettingsPanel's
// `jumpTo` scrolls to `[data-setting-id]`.
//
// Shared by SettingsPanel and the section files it renders (Claude
// integration, accounts, quick commands), which is why it is its own module:
// those files are imported BY SettingsPanel and cannot import from it.

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { placePopover } from '../AgentToolbar/placePopover';
import Field from '../ui/Field';
import Popover from '../ui/Popover';

// ─── Dialogs Settings owns ───────────────────────────────────────────────────
//
// A modal opened FROM Settings (key capture, paired devices) is the top-most
// layer: Escape closes only it and Ctrl/Cmd+F must not pull focus to the
// search box behind it. Settings' own key handler runs first (window,
// capture), so it has to know when one is open. Each owner registers while it
// is open; a DOM query for any aria-modal dialog would also match dialogs
// Settings does not own (the floating terminal stays mounted, hidden).
// Lives here so section files (which SettingsPanel imports) can use it too.
export const OwnedDialogContext = createContext<(delta: number) => void>(() => undefined);

export function useOwnedDialog(open: boolean): void {
  const register = useContext(OwnedDialogContext);
  useEffect(() => {
    if (!open) return;
    register(1);
    return () => register(-1);
  }, [open, register]);
}

/**
 * One-line clamp with an info button that appears only when the line actually
 * overflows at the current width (measured, not guessed from the length, so
 * CJK copy and a resized window both get it right). The clamp is visual: the
 * full text stays in the DOM, so a control's aria-describedby reads all of it.
 */
function useClamp<T extends HTMLElement>(text: string | undefined) {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return {
    ref,
    info: overflows && text ? <InfoTip text={text} /> : null,
  };
}

/** Is this focus from the keyboard? A mouse click focuses the button too, and
 *  that click already toggles the tip, so only keyboard focus opens it. */
function isKeyboardFocus(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * The info button after clamped copy: hover or keyboard focus shows the full
 * text, a click pins it open, Escape or a click elsewhere closes it. The tip
 * is portalled and fixed-positioned because the section container clips its
 * overflow. While it is open it counts as a dialog Settings owns, so Escape
 * closes the tip rather than Settings.
 */
function InfoTip({ text }: { text: string }) {
  const t = useT();
  const tipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || focused || pinned;
  useOwnedDialog(open);

  const enter = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    setHovered(true);
  };
  // A short grace period lets the pointer cross from the button to the tip.
  const leave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(false), 120);
  };
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current;
      const tip = tipRef.current;
      if (!button || !tip) return;
      const r = button.getBoundingClientRect();
      const pos = placePopover(
        { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        { width: tip.offsetWidth, height: tip.offsetHeight },
      );
      tip.style.top = `${pos.top}px`;
      tip.style.left = `${pos.left}px`;
    };
    place();
    const close = () => {
      setHovered(false);
      setFocused(false);
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || tipRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`settings-info ${FOCUS_RING}`}
        aria-label={t('settings.moreInfo')}
        aria-expanded={open}
        aria-controls={open ? tipId : undefined}
        onClick={() => {
          // A click on a pinned tip closes it even while hover or keyboard
          // focus would otherwise hold it open.
          if (pinned) {
            setPinned(false);
            setHovered(false);
            setFocused(false);
          } else {
            setPinned(true);
          }
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={(e) => { if (isKeyboardFocus(e.currentTarget)) setFocused(true); }}
        onBlur={() => setFocused(false)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7.25v3.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
        </svg>
      </button>
      {open && createPortal(
        <Popover
          ref={tipRef}
          id={tipId}
          role="tooltip"
          className="settings-info-tip"
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {text}
        </Popover>,
        document.body,
      )}
    </>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  action,
  overflowVisible = false,
  children,
  'data-testid': testId,
}: {
  id?: string;
  /** Omitted for a lead group whose one row already names itself. */
  title?: string;
  description?: string;
  /** Trailing control on the heading line (e.g. a Refresh or Reset). */
  action?: ReactNode;
  /** For a group holding an in-place dropdown (the font list): the group's
   *  rounded clip would otherwise cut the list off. */
  overflowVisible?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const clamp = useClamp<HTMLParagraphElement>(description);
  return (
    <section className="settings-section scroll-mt-4" data-setting-id={id} data-testid={testId}>
      {(title || action) && (
        <div className="settings-section-head">
          {title && <h3 className="ui-group-label settings-section-title">{title}</h3>}
          {action}
        </div>
      )}
      {description && (
        <div className="settings-section-desc">
          <p ref={clamp.ref} className="m-0 settings-clamp">{description}</p>
          {clamp.info}
        </div>
      )}
      <div className={`ui-group${overflowVisible ? ' settings-group-open' : ''}`}>{children}</div>
    </section>
  );
}

export function SettingRow({
  id,
  label,
  description,
  layout = 'inline',
  children,
  ...rest
}: {
  id?: string;
  /** Usually plain text; a node when part of the label is muted (a row's
   *  "· required" suffix). */
  label: ReactNode;
  description?: string;
  layout?: 'inline' | 'stacked';
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'children'>) {
  const clamp = useClamp<HTMLSpanElement>(description);
  return (
    <div {...rest} data-setting-id={id} className="settings-row scroll-mt-4">
      <Field
        label={label}
        layout={layout}
        description={description == null ? undefined : (
          <span className="settings-desc-line">
            <span ref={clamp.ref} className="settings-clamp">{description}</span>
            {clamp.info}
          </span>
        )}
      >
        {children}
      </Field>
    </div>
  );
}

/** A muted line inside a section's container: a caveat, an empty state, or a
 *  status that belongs to the rows above it. `tone` tints the text only. */
export function SettingNote({
  children,
  tone = 'muted',
  className = '',
  ...rest
}: HTMLAttributes<HTMLParagraphElement> & { tone?: 'muted' | 'warning' | 'danger' }) {
  return (
    <p className={`ui-note settings-note ${className}`} data-tone={tone} {...rest}>
      {children}
    </p>
  );
}
