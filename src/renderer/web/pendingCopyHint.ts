/**
 * The browser app's pill while a refused copy waits (webClipboardApi): a
 * button in the copy toasts' slot and style. Clicking it finishes the copy
 * inside that click. It invites a click only: a key pressed "to finish
 * copying" would also reach the agent in the pane.
 */
import { t } from '../i18n';

const HINT_ID = 'wmux-pending-copy-toast';
const STATUS_ID = 'wmux-pending-copy-status';
let finishRef: () => void = () => undefined;

/** Show or hide the pill; `finish` is what its click runs. No timer: the pending copy decides. */
export function setPendingCopyHint(visible: boolean, finish: () => void, doc: Document = document): void {
  finishRef = finish;
  let el = doc.getElementById(HINT_ID) as HTMLButtonElement | null;
  if (!el) {
    if (!visible) return;
    el = doc.createElement('button');
    el.type = 'button';
    el.id = HINT_ID;
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--accent-yellow);color:var(--bg-base);font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border:0;border-radius:4px;z-index:9999;cursor:pointer;opacity:0;transition:opacity 0.2s';
    // The press is the pill's own: it stops here, and the mouse press does not
    // move focus off the terminal.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchend', 'click']) {
      el.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'mousedown') e.preventDefault();
      });
    }
    el.addEventListener('click', () => finishRef());
    doc.body.appendChild(el);
  }
  el.textContent = t('terminal.copyPendingGesture');
  el.disabled = !visible;
  el.style.pointerEvents = visible ? 'auto' : 'none';
  el.style.opacity = visible ? '1' : '0';
  // The button takes no focus when it appears, so a screen reader hears the
  // wait from a polite status region. A region is only read when its text
  // changes after it is in the page, so a new one is filled a tick later.
  const pill = el;
  const say = () => (pill.disabled ? '' : t('terminal.copyPendingGesture'));
  const status = doc.getElementById(STATUS_ID);
  if (status) { status.textContent = say(); return; }
  const region = doc.createElement('div');
  region.id = STATUS_ID;
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
  doc.body.appendChild(region);
  setTimeout(() => { region.textContent = say(); }, 0);
}
