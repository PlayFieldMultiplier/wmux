import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import { IconCheck, IconWarning } from '../icons';
import type { TailscaleChecklist as Checklist, TailscaleFix } from '../../../shared/web';
import { fixForProblem, readTailscale } from './tailnetCheck';

/** After a button opened Tailscale, check again once it had a moment to come up. */
export const TAILSCALE_RECHECK_AFTER_OPEN_MS = 4_000;

/**
 * The ONE action a failed check offers. It opens Tailscale's download page or
 * brings the Tailscale app forward, and nothing more: signing in, connecting
 * and installing stay the person's own steps inside Tailscale. `peer-help`
 * only unfolds how to sign the other device in.
 */
export function TailscaleFixButton({ fix, onOpened }: { fix: TailscaleFix; onOpened?: () => void }) {
  const t = useT();
  const [help, setHelp] = useState(false);
  const [noApp, setNoApp] = useState(false);
  // Also rendered to static markup (no window) by the popover's tests.
  const open = typeof window === 'undefined' ? undefined : window.electronAPI?.web?.tailscaleOpen;

  if (fix === 'peer-help') {
    return (
      <>
        <Button size="sm" variant="secondary" aria-expanded={help} onClick={() => setHelp((v) => !v)} data-tailscale-fix="peer-help">
          {t('tailscale.fix.peerHelp')}
        </Button>
        {help && <p className="wmux-remote-ts-help" data-tailscale-help>{t('tailscale.help.peer')}</p>}
      </>
    );
  }
  if (!open) return null;
  const click = async () => {
    const res = await open(fix === 'download' ? 'download' : 'app').catch(() => null);
    // No app to bring forward (Linux runs the daemon only): say how instead.
    setNoApp(res?.ok !== true);
    if (res?.ok) onOpened?.();
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => void click()} data-tailscale-fix={fix}>
        {t(fix === 'download' ? 'tailscale.fix.download' : fix === 'sign-in' ? 'tailscale.fix.signIn' : 'tailscale.fix.open')}
      </Button>
      {fix === 'sign-in' && <p className="wmux-remote-ts-help">{t('tailscale.help.signIn')}</p>}
      {noApp && fix !== 'download' && <p className="wmux-remote-ts-help" role="status">{t('tailscale.help.noApp')}</p>}
    </>
  );
}

/**
 * The fix button for a `wmux web --tailscale` problem (the share popover, the
 * phone wizard), or nothing when no click can fix it.
 */
export function TailscaleProblemFix({ problem, testId }: { problem: string | undefined; testId?: string }) {
  const fix = fixForProblem(problem);
  if (!fix) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-tailscale-problem-fix={testId ?? ''}>
      <TailscaleFixButton fix={fix} />
    </div>
  );
}

/**
 * Tailscale on the Remote page: four checks from one read-only status read,
 * run when the page opens and on Check again — never on the page's 10 s poll,
 * which would start a tailscale process six times a minute. All passing, the
 * four sit on one line; otherwise each gets its own row and the first failure
 * carries the one button that fixes it.
 */
export default function TailscaleChecklist() {
  const t = useT();
  const [list, setList] = useState<Checklist | null>(null);
  const [checking, setChecking] = useState(true);
  const mounted = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    mounted.current = false;
    window.clearTimeout(timer.current);
  }, []);

  const run = useCallback(async () => {
    setChecking(true);
    const next = await readTailscale();
    if (!mounted.current) return;
    setList(next);
    setChecking(false);
  }, []);
  useEffect(() => { void run(); }, [run]);
  const recheckSoon = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void run(); }, TAILSCALE_RECHECK_AFTER_OPEN_MS);
  }, [run]);

  if (!window.electronAPI?.web?.tailscaleCheck) return null;
  const summary = checking && !list ? t('tailscale.checking')
    : !list ? t('tailscale.unavailable')
      : list.ok ? (list.peersOnline === 1 ? t('tailscale.readyOne') : t('tailscale.ready', { count: list.peersOnline ?? 0 }))
        : '';
  return (
    <div className="wmux-remote-ts" data-tailscale-checklist data-ok={list?.ok ? 'true' : undefined}>
      <div className="wmux-remote-ts-head">
        <span className="wmux-remote-machine-lbl">{t('tailscale.title')}</span>
        {summary && <span className="wmux-remote-ts-sum" role="status">{summary}</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void run()} data-tailscale-recheck>
          {checking ? t('tailscale.checking') : t('tailscale.checkAgain')}
        </Button>
      </div>
      {list && (
        <ul className="wmux-remote-ts-list" aria-label={t('tailscale.title')}>
          {list.items.map((item) => (
            <li key={item.id} className="wmux-remote-ts-row" data-ts-check={item.id} data-state={item.state}>
              <span className="wmux-remote-ts-mark" aria-hidden="true">
                {item.state === 'pass' ? <span style={{ color: 'var(--accent-green)' }}><IconCheck size={12} /></span>
                  : item.state === 'fail' ? <span style={{ color: 'var(--accent-yellow)' }}><IconWarning size={12} /></span>
                    : <span className="wmux-remote-dot is-off" />}
              </span>
              <span>
                {t(`tailscale.check.${item.id}`)}
                <span className="sr-only">{` — ${t(`tailscale.state.${item.state}`)}`}</span>
              </span>
              {item.state === 'fail' && item.reason && (
                <span className="wmux-remote-ts-why" data-ts-reason={item.reason}>{t(`tailscale.reason.${item.reason}`)}</span>
              )}
              {item.state === 'fail' && item.fix && <TailscaleFixButton fix={item.fix} onOpened={recheckSoon} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
