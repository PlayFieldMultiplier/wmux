import { useCallback, useEffect, useRef, useState, type ReactElement, type Ref } from 'react';
import Button from '../ui/Button';
import { IconWarning } from '../icons';
import {
  allowHintKey,
  failedError,
  firewallDetailsText,
  firewallOffer,
  networkSettingsUri,
  partlyPublicSentence,
  type FirewallAction,
  type FirewallActionResult,
  type FirewallListener,
  type InboundStatusView,
  type NetworkSettingsUri,
} from '../../../shared/netFirewall';
import { listenProblemSentence, type ListenProblemReport } from '../../../shared/netListen';

// Remote pairing's firewall and port problems, drawn the same way wherever
// they show (the Remote page, Connect a PC's invite, Settings › LAN, Share &
// pair): a notice row (warning glyph · the sentence + one line · the action)
// when something needs doing, a muted line when the port is allowed. Colour
// is the caution yellow on the glyph and the hairline only (DESIGN.md
// §Remote): never a wash, never the needs-you orange.
//
// The check runs a PowerShell process in the daemon, so it runs only on a
// deliberate event — the surface opening, Check firewall, after a Fix, the
// listener's port or state changing (`checkKey`), the window coming back
// after Open network settings / Open Windows Firewall — never on a poll.
//
// A row is a live status by itself, except where the surface has a stable
// aria-live container around the rows (the Remote page's `.wmux-remote-fw`,
// `live={false}`): a row that arrives already filled is often not announced,
// a change inside a container that was there all along is.

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface FirewallState {
  status: InboundStatusView | null;
  checking: boolean;
  /**
   * The last check, or the check after an action, failed (no daemon, the IPC
   * rejected): whatever status is kept is not current, so the "could not
   * read" row with Check is drawn instead of it.
   */
  readFailed: boolean;
  busy: 'fix' | 'remove' | null;
  /** How the last Fix or Remove ended, until the next check. */
  outcome: FirewallActionResult['outcome'] | null;
  /** The last action was a Fix, and the check after it says the rule is there. */
  fixed: boolean;
  copied: boolean;
  /** Counts finished actions, so the view can put focus back on what replaced the button. */
  settled: number;
}

export interface FirewallActions {
  check: () => void;
  fix: () => void;
  remove: () => void;
  copyDetails: () => void;
  /** `page`: a Windows Settings page (NETWORK_SETTINGS_URIS) for 'network'. */
  open: (which: 'firewall' | 'network', page?: NetworkSettingsUri) => void;
}

export type FirewallController = FirewallState & FirewallActions;

const IDLE: FirewallState = { status: null, checking: false, readFailed: false, busy: null, outcome: null, fixed: false, copied: false, settled: 0 };

/** The outcome shown when the action's own IPC call failed: nothing says whether it ran. */
const ACTION_UNKNOWN: FirewallActionResult['outcome'] = { kind: 'failed', stage: null, code: null };

/** `14:02`, in the viewer's locale. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The firewall state of one listener. `enabled`: there is a listener to
 * check (it listens; for the web server, beyond loopback). The check runs
 * when it turns on and whenever `checkKey` changes (port, restart); Check
 * firewall and the re-check after an Open… ask for a probe that starts then.
 */
export function useFirewall(listener: FirewallListener, opts: { enabled: boolean; checkKey: string }): FirewallController {
  const [state, setState] = useState<FirewallState>(IDLE);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.netFirewall;
  const seq = useRef(0);

  const runCheck = useCallback((fresh: boolean) => {
    if (!api) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, checking: true }));
    void api.status(listener, fresh).then(
      (status) => {
        if (!mounted.current || n !== seq.current) return;
        setState((s) => ({ ...s, status, checking: false, readFailed: false, outcome: null, fixed: false }));
      },
      () => {
        if (!mounted.current || n !== seq.current) return;
        setState((s) => ({ ...s, checking: false, readFailed: true }));
      },
    );
  }, [api, listener]);
  const check = useCallback(() => runCheck(true), [runCheck]);

  useEffect(() => {
    if (opts.enabled) runCheck(false);
    else {
      seq.current += 1;
      setState(IDLE);
    }
  }, [opts.enabled, opts.checkKey, runCheck]);

  // After Open network settings / Open Windows Firewall the person changes
  // something outside wmux; the first time the window is back, look again.
  const recheckOnReturn = useRef(false);
  const latestCheck = useRef(check);
  latestCheck.current = check;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const back = () => {
      if (!recheckOnReturn.current || document.visibilityState === 'hidden') return;
      recheckOnReturn.current = false;
      latestCheck.current();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  const act = useCallback((kind: 'fix' | 'remove') => {
    if (!api) return;
    setState((s) => ({ ...s, busy: kind }));
    const run = kind === 'fix' ? api.fix(listener) : api.remove(listener);
    void run.then(
      (r) => {
        if (!mounted.current) return;
        // Any check still running started before this answer: drop it.
        seq.current += 1;
        setState((s) => {
          const refused = r.outcome.kind === 'refused';
          const status = r.status ? { ...r.status, elevation: s.status?.elevation ?? 'consent' } : refused ? s.status : null;
          return {
            ...s,
            busy: null,
            checking: false,
            // An action whose check after it failed leaves nothing current to show.
            readFailed: !refused && !r.status,
            status,
            outcome: r.outcome,
            fixed: kind === 'fix' && r.outcome.kind === 'ok' && status?.verdict === 'covered',
            settled: s.settled + 1,
          };
        });
        // A refusal means what was shown is no longer true: look again.
        if (r.outcome.kind === 'refused' && r.outcome.refusal === 'changed') check();
      },
      () => {
        if (!mounted.current) return;
        seq.current += 1;
        setState((s) => ({ ...s, busy: null, checking: false, readFailed: true, outcome: ACTION_UNKNOWN, fixed: false, settled: s.settled + 1 }));
      },
    );
  }, [api, listener, check]);

  const copyDetails = useCallback(() => {
    const status = state.status;
    if (!status) return;
    void navigator.clipboard?.writeText(firewallDetailsText(status)).then(() => {
      if (!mounted.current) return;
      setState((s) => ({ ...s, copied: true }));
      window.setTimeout(() => { if (mounted.current) setState((s) => ({ ...s, copied: false })); }, 1500);
    }, () => undefined);
  }, [state.status]);

  const open = useCallback((which: 'firewall' | 'network', page?: NetworkSettingsUri) => {
    recheckOnReturn.current = true;
    void (page === undefined ? api?.open(which) : api?.open(which, page));
  }, [api]);

  return { ...state, check, fix: () => act('fix'), remove: () => act('remove'), copyDetails, open };
}

function outcomeLine(c: FirewallState, t: T): string | null {
  const o = c.outcome;
  if (!o) return null;
  if (o.kind === 'cancelled') {
    if (c.status?.platform === 'darwin') return t('net.fw.cancelledMac');
    return c.status?.elevation === 'credential' ? `${t('net.fw.cancelled')} ${t('net.fw.cancelledNoAdmin')}` : t('net.fw.cancelled');
  }
  if (o.kind === 'failed') {
    const e = failedError(o);
    return t('net.fw.failed', { error: 'key' in e ? t(e.key) : e.code });
  }
  if (o.kind === 'refused') return o.refusal === 'busy' ? t('net.fw.busy') : null;
  if (o.kind === 'running') return t('net.fw.stillRunning');
  // ok: the check after it says what is true; only a failed check needs words.
  return c.readFailed ? t('net.fw.okUnchecked') : null;
}

/** The newest "another PC reached this one": the probe's, or the listener's live count. */
function seenTime(c: FirewallState, live: number | null | undefined): number | null {
  const a = c.status?.inboundSeenAt ?? null;
  const b = live ?? null;
  return a === null ? b : b === null ? a : Math.max(a, b);
}

function actionButton(action: FirewallAction, c: FirewallController, primary: boolean, t: T, listener: FirewallListener) {
  const disabled = c.busy !== null || c.checking;
  switch (action) {
    case 'fix': {
      // aria-disabled, not disabled, while it runs: the focused button keeps focus.
      const running = c.busy === 'fix';
      return (
        <Button
          key="fix"
          size="sm"
          variant={primary && !disabled ? 'primary' : 'secondary'}
          aria-disabled={disabled || undefined}
          aria-busy={running || undefined}
          onClick={disabled ? undefined : c.fix}
          data-firewall-fix={listener}
        >
          {running ? t('net.fw.working') : t('net.fw.allow')}
        </Button>
      );
    }
    case 'openFirewall':
      return <Button key="fw" size="sm" variant="secondary" onClick={() => c.open('firewall')} data-firewall-open="firewall">{t('net.fw.openFirewall')}</Button>;
    case 'openNetworkSettings': {
      // Windows: the page of the Public networks' adapter kind, where its
      // network profile is switched; Network status when that is not known.
      const page = c.status?.platform === 'win32' ? networkSettingsUri(c.status.publicMedium) : undefined;
      return (
        <Button key="net" size="sm" variant="secondary" onClick={() => c.open('network', page)} data-firewall-open="network" data-settings-page={page}>
          {t('net.fw.openNetworkSettings')}
        </Button>
      );
    }
    case 'copyDetails':
      return <Button key="copy" size="sm" variant="secondary" onClick={c.copyDetails} data-firewall-copy>{c.copied ? t('web.copied') : t('net.fw.copyDetails')}</Button>;
    case 'check':
      return (
        <Button key="check" size="sm" variant="secondary" disabled={disabled} onClick={c.check} data-firewall-check>
          {c.checking ? t('net.fw.checking') : t('net.fw.check')}
        </Button>
      );
  }
}

function NoticeRow({ title, detail, actions, testId, live, rowRef }: {
  title: string;
  detail: Array<string | null>;
  actions: ReactElement[];
  testId: Record<string, string>;
  live: boolean;
  rowRef?: Ref<HTMLDivElement>;
}) {
  const lines = detail.filter((d): d is string => !!d);
  return (
    <div className={rowRef ? 'wmux-fw-notice focus:outline-none' : 'wmux-fw-notice'} ref={rowRef} tabIndex={rowRef ? -1 : undefined} {...testId}>
      <div className="ui-notice ui-row" data-tone="warning" role={live ? 'status' : undefined}>
        <span className="ui-row-icon ui-notice-tone" aria-hidden="true"><IconWarning size={14} /></span>
        <div className="ui-row-text">
          <p className="ui-row-title">{title}</p>
          {lines.map((l, i) => <p key={i} className="ui-row-detail">{l}</p>)}
        </div>
        {actions.length > 0 && <div className="ui-row-action">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * After a Fix or Remove its button is often gone (the row became the muted
 * line). Focus would fall to the page; put it on the first row instead.
 */
function useFocusAfterAction(settled: number) {
  const first = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (settled === 0 || typeof document === 'undefined') return;
    const active = document.activeElement;
    if (!active || active === document.body) first.current?.focus();
  }, [settled]);
  return (el: HTMLElement | null) => { first.current = el; };
}

/**
 * The firewall rows for one listener: the problem (or the muted "allowed"
 * line) and, separately, the warning about an earlier Windows prompt that
 * opened wmux to public networks. `primary`: the Fix may be this surface's
 * one primary (the Remote page with no Accept pending). `quiet`: a surface
 * whose Details already says "allowed" (the Remote page) draws neither the
 * "Checking…" line nor the allowed line, except right after a Fix.
 * `ownCheck`: the surface draws its own Check firewall (Connect a PC's
 * invite), so this draws neither "Checking…" nor a second Check.
 * `seenAt`: the listener's live "another PC reached this one" time.
 * `live`: false where the surface's container is the aria-live region.
 */
export function FirewallNoticeView({ c, listener, primary, quiet = false, ownCheck = false, seenAt, live = true, t }: {
  c: FirewallController;
  listener: FirewallListener;
  primary: boolean;
  quiet?: boolean;
  ownCheck?: boolean;
  seenAt?: number | null;
  live?: boolean;
  t: T;
}) {
  const focusRef = useFocusAfterAction(c.settled);
  const s = c.status;
  const outcome = outcomeLine(c, t);
  if (c.readFailed) {
    return (
      <NoticeRow
        title={t('net.fw.unknown')}
        detail={[outcome]}
        actions={ownCheck ? [] : [actionButton('check', c, false, t, listener)]}
        testId={{ 'data-firewall-notice': listener, 'data-verdict': 'unknown' }}
        live={live}
        rowRef={focusRef}
      />
    );
  }
  if (!s) {
    if (c.checking && !quiet && !ownCheck) return <p className="ui-note" role={live ? 'status' : undefined} data-firewall-checking={listener}>{t('net.fw.checking')}</p>;
    return null;
  }
  const offer = firewallOffer(s);
  const port = s.port ?? 0;
  const partly = partlyPublicSentence(s);
  const rows: ReactElement[] = [];
  if (offer.notice && offer.sentence) {
    const actions = [...offer.actions].filter((a) => !(ownCheck && a === 'check'));
    // After a declined prompt the next step is someone else's: give them the details.
    if (c.outcome?.kind === 'cancelled' && !actions.includes('copyDetails')) actions.push('copyDetails');
    const hint = actions.includes('fix')
      ? s.platform === 'darwin' ? t('net.fw.allowHintMac') : t(allowHintKey(s.elevation), { port })
      : null;
    rows.push(
      <NoticeRow
        key="main"
        title={t(offer.sentence.key, offer.sentence.vars)}
        detail={[outcome, hint]}
        actions={actions.map((a) => actionButton(a, c, primary, t, listener))}
        testId={{ 'data-firewall-notice': listener, 'data-verdict': s.verdict }}
        live={live}
        rowRef={focusRef}
      />,
    );
  } else if (offer.sentence && (!quiet || c.outcome !== null)) {
    const after = c.fixed ? t('net.fw.nowRetry') : null;
    const at = seenTime(c, seenAt);
    const seen = at ? t('net.fw.inboundSeen', { time: clockTime(at) }) : null;
    rows.push(
      <p key="line" ref={focusRef} tabIndex={-1} className="ui-note focus:outline-none" role={live ? 'status' : undefined} data-firewall-line={listener} data-verdict={s.verdict}>
        {[t(offer.sentence.key, offer.sentence.vars), outcome, after, seen].filter(Boolean).join(' ')}
      </p>,
    );
  }
  // Offered on a Private and a Public network: the Public one gets its own
  // row, with the page where its profile is switched.
  if (partly && s.platform === 'win32') {
    rows.push(
      <NoticeRow
        key="partly"
        title={t(partly.key, partly.vars)}
        detail={[t('net.fw.partlyPublicHint', { network: partly.vars.network })]}
        actions={[actionButton('openNetworkSettings', c, false, t, listener)]}
        testId={{ 'data-firewall-partly': listener }}
        live={live}
      />,
    );
  }
  if (s.exposedPublic && s.platform === 'win32') {
    rows.push(
      <NoticeRow
        key="public"
        title={t('net.fw.exposedPublic')}
        detail={[s.publicBlocked ? t('net.fw.exposedPublicFixed', { port }) : null]}
        actions={[actionButton('openFirewall', c, false, t, listener)]}
        testId={{ 'data-firewall-exposed': listener }}
        live={live}
      />,
    );
  }
  return rows.length > 0 ? <>{rows}</> : null;
}

/** The Details value: what the check said, and when another PC last reached this one. */
export function FirewallDetailValue({ c, seenAt, t }: { c: FirewallController; seenAt?: number | null; t: T }) {
  const s = c.status;
  if (c.readFailed || !s) {
    const text = c.checking ? t('net.fw.checking') : c.readFailed ? t('net.fw.unknown') : t('net.fw.notChecked');
    return <span data-firewall-detail={c.readFailed ? 'unknown' : 'unchecked'}>{text}</span>;
  }
  const offer = firewallOffer(s);
  const at = seenTime(c, seenAt);
  const parts = [offer.sentence ? t(offer.sentence.key, offer.sentence.vars) : t('net.fw.notChecked'), at ? t('net.fw.inboundSeen', { time: clockTime(at) }) : null];
  return <span data-firewall-detail={s.verdict}>{parts.filter(Boolean).join(' ')}</span>;
}

/**
 * The Details actions: Check firewall, always (after changing a network or
 * a rule outside wmux, this is how the page learns of it), and Remove for
 * our own rule.
 */
export function FirewallDetailActions({ c, t }: { c: FirewallController; t: T }) {
  const s = c.status;
  const removing = c.busy === 'remove';
  const disabled = c.busy !== null || c.checking;
  return (
    <span className="inline-flex items-center gap-1">
      {s && !c.readFailed && s.verdict === 'covered' && s.platform === 'win32' && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('net.fw.removeAria')}
          aria-disabled={disabled || undefined}
          aria-busy={removing || undefined}
          onClick={disabled ? undefined : c.remove}
          data-firewall-remove
        >
          {removing ? t('net.fw.working') : t('net.fw.remove')}
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={c.check} data-firewall-check>
        {c.checking ? t('net.fw.checking') : t('net.fw.check')}
      </Button>
    </span>
  );
}

// ── A listener that could not bind ───────────────────────────────────────────

/**
 * The daemon's explanation of a failed bind (who holds the port, a port to
 * try). Read once per distinct failure (`failureKey` = code and port), never
 * on a poll: it runs netstat and tasklist.
 */
export function useListenProblem(listener: FirewallListener, failureKey: string | null): ListenProblemReport | null {
  const [report, setReport] = useState<ListenProblemReport | null>(null);
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.netFirewall;
  useEffect(() => {
    setReport(null);
    if (!failureKey || !api) return;
    let live = true;
    void api.listenProblem(listener).then((r) => { if (live) setReport(r); }, () => undefined);
    return () => { live = false; };
  }, [api, listener, failureKey]);
  return report;
}

/**
 * A notice for a listener that could not open its port: the sentence (or
 * `fallback`, the raw reason, until the explanation arrives or when there is
 * none), and "Use port N" when a free port was found. `repair`: changing
 * this port means paired PCs must be invited again (A2A). `busy`: another
 * action runs, so the button waits; `working`: this move is the one running.
 * `live`: false where the surface's container is the aria-live region.
 */
export function ListenProblemView({ report, fallback, onUsePort, busy, working = false, repair, primary, listener, live = true, t }: {
  report: ListenProblemReport | null;
  fallback: string | null;
  onUsePort?: (port: number) => void;
  busy: boolean;
  working?: boolean;
  repair: boolean;
  primary: boolean;
  listener: FirewallListener;
  live?: boolean;
  t: T;
}) {
  const sentence = report ? listenProblemSentence(report) : null;
  const title = sentence ? t(sentence.key, sentence.vars) : fallback;
  if (!title) return null;
  const next = report?.suggestion ?? null;
  const actions = next !== null && onUsePort
    ? [
        <Button
          key="use"
          size="sm"
          variant={primary && !busy ? 'primary' : 'secondary'}
          aria-disabled={busy || undefined}
          aria-busy={working || undefined}
          onClick={busy ? undefined : () => onUsePort(next)}
          data-listen-use-port={next}
        >
          {working ? t('net.fw.working') : t('net.listen.usePort', { next })}
        </Button>,
      ]
    : [];
  return (
    <NoticeRow
      title={title}
      detail={[next !== null && repair ? t('net.listen.usePortRepair') : null]}
      actions={actions}
      testId={{ 'data-listen-problem': listener, 'data-problem': report?.problem.kind ?? 'raw' }}
      live={live}
    />
  );
}
