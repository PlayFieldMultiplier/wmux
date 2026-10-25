import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import Button from '../ui/Button';
import { IconWarning } from '../icons';
import {
  allowHintKey,
  failedError,
  firewallDetailsText,
  firewallOffer,
  partlyPublicSentence,
  type FirewallAction,
  type FirewallActionResult,
  type FirewallListener,
  type InboundStatusView,
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
// listener's port or state changing (`checkKey`) — never on a poll.

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface FirewallState {
  status: InboundStatusView | null;
  checking: boolean;
  /** The check itself failed (no daemon, the IPC rejected). */
  readFailed: boolean;
  busy: 'fix' | 'remove' | null;
  /** How the last Fix or Remove ended, until the next check. */
  outcome: FirewallActionResult['outcome'] | null;
  /** The last action was a Fix, and the check after it says the rule is there. */
  fixed: boolean;
  copied: boolean;
}

export interface FirewallActions {
  check: () => void;
  fix: () => void;
  remove: () => void;
  copyDetails: () => void;
  open: (which: 'firewall' | 'network') => void;
}

export type FirewallController = FirewallState & FirewallActions;

const IDLE: FirewallState = { status: null, checking: false, readFailed: false, busy: null, outcome: null, fixed: false, copied: false };

/** `14:02`, in the viewer's locale. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The firewall state of one listener. `enabled`: there is a listener to
 * check (it listens; for the web server, beyond loopback). The check runs
 * when it turns on and whenever `checkKey` changes (port, restart).
 */
export function useFirewall(listener: FirewallListener, opts: { enabled: boolean; checkKey: string }): FirewallController {
  const [state, setState] = useState<FirewallState>(IDLE);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.netFirewall;
  const seq = useRef(0);

  const check = useCallback(() => {
    if (!api) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, checking: true }));
    void api.status(listener).then(
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

  useEffect(() => {
    if (opts.enabled) check();
    else {
      seq.current += 1;
      setState(IDLE);
    }
  }, [opts.enabled, opts.checkKey, check]);

  const act = useCallback((kind: 'fix' | 'remove') => {
    if (!api) return;
    setState((s) => ({ ...s, busy: kind }));
    const run = kind === 'fix' ? api.fix(listener) : api.remove(listener);
    void run.then(
      (r) => {
        if (!mounted.current) return;
        seq.current += 1;
        setState((s) => {
          const status = r.status ? { ...r.status, elevation: s.status?.elevation ?? 'consent' } : s.status;
          return {
            ...s,
            busy: null,
            status,
            outcome: r.outcome,
            fixed: kind === 'fix' && r.outcome.kind === 'ok' && status?.verdict === 'covered',
          };
        });
        // A refusal means what was shown is no longer true: look again.
        if (r.outcome.kind === 'refused' && r.outcome.refusal === 'changed') check();
      },
      () => {
        if (mounted.current) setState((s) => ({ ...s, busy: null, readFailed: true }));
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

  const open = useCallback((which: 'firewall' | 'network') => { void api?.open(which); }, [api]);

  return { ...state, check, fix: () => act('fix'), remove: () => act('remove'), copyDetails, open };
}

function outcomeLine(c: FirewallState, t: T): string | null {
  const o = c.outcome;
  if (!o) return null;
  if (o.kind === 'cancelled') {
    return c.status?.elevation === 'credential' ? `${t('net.fw.cancelled')} ${t('net.fw.cancelledNoAdmin')}` : t('net.fw.cancelled');
  }
  if (o.kind === 'failed') {
    const e = failedError(o);
    return t('net.fw.failed', { error: 'key' in e ? t(e.key) : e.code });
  }
  return null;
}

function actionButton(action: FirewallAction, c: FirewallController, primary: boolean, t: T, listener: FirewallListener) {
  const disabled = c.busy !== null || c.checking;
  switch (action) {
    case 'fix':
      return (
        <Button key="fix" size="sm" variant={primary && !disabled ? 'primary' : 'secondary'} disabled={disabled} onClick={c.fix} data-firewall-fix={listener}>
          {t('net.fw.allow')}
        </Button>
      );
    case 'openFirewall':
      return <Button key="fw" size="sm" variant="secondary" onClick={() => c.open('firewall')} data-firewall-open="firewall">{t('net.fw.openFirewall')}</Button>;
    case 'openNetworkSettings':
      return <Button key="net" size="sm" variant="secondary" onClick={() => c.open('network')} data-firewall-open="network">{t('net.fw.openNetworkSettings')}</Button>;
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

function NoticeRow({ title, detail, actions, testId }: { title: string; detail: Array<string | null>; actions: ReactElement[]; testId: Record<string, string> }) {
  const lines = detail.filter((d): d is string => !!d);
  return (
    <div className="wmux-fw-notice" {...testId}>
      <div className="ui-notice ui-row" data-tone="warning" role="status">
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
 * The firewall rows for one listener: the problem (or the muted "allowed"
 * line) and, separately, the warning about an earlier Windows prompt that
 * opened wmux to public networks. `primary`: the Fix may be this surface's
 * one primary (the Remote page with no Accept pending). `quiet`: a surface
 * whose Details already says "allowed" (the Remote page) draws neither the
 * "Checking…" line nor the allowed line, except right after a Fix.
 */
export function FirewallNoticeView({ c, listener, primary, quiet = false, t }: { c: FirewallController; listener: FirewallListener; primary: boolean; quiet?: boolean; t: T }) {
  const s = c.status;
  if (!s) {
    if (c.checking && !quiet) return <p className="ui-note" role="status" data-firewall-checking={listener}>{t('net.fw.checking')}</p>;
    if (c.readFailed) {
      return <NoticeRow title={t('net.fw.unknown')} detail={[]} actions={[actionButton('check', c, false, t, listener)]} testId={{ 'data-firewall-notice': listener, 'data-verdict': 'unknown' }} />;
    }
    return null;
  }
  const offer = firewallOffer(s);
  const port = s.port ?? 0;
  const partly = partlyPublicSentence(s);
  const outcome = outcomeLine(c, t);
  const rows: ReactElement[] = [];
  if (offer.notice && offer.sentence) {
    const actions = [...offer.actions];
    // After a declined prompt the next step is someone else's: give them the details.
    if (c.outcome?.kind === 'cancelled' && !actions.includes('copyDetails')) actions.push('copyDetails');
    const hint = actions.includes('fix')
      ? s.platform === 'darwin' ? t('net.fw.allowHintMac') : t(allowHintKey(s.elevation), { port })
      : null;
    rows.push(
      <NoticeRow
        key="main"
        title={t(offer.sentence.key, offer.sentence.vars)}
        detail={[outcome, hint, partly ? t(partly.key, partly.vars) : null]}
        actions={actions.map((a) => actionButton(a, c, primary, t, listener))}
        testId={{ 'data-firewall-notice': listener, 'data-verdict': s.verdict }}
      />,
    );
  } else if (offer.sentence && (!quiet || c.outcome !== null)) {
    const after = c.fixed ? t('net.fw.nowRetry') : null;
    const seen = s.inboundSeenAt ? t('net.fw.inboundSeen', { time: clockTime(s.inboundSeenAt) }) : null;
    rows.push(
      <p key="line" className="ui-note" role="status" data-firewall-line={listener} data-verdict={s.verdict}>
        {[t(offer.sentence.key, offer.sentence.vars), outcome, after, seen, partly ? t(partly.key, partly.vars) : null].filter(Boolean).join(' ')}
      </p>,
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
      />,
    );
  }
  return rows.length > 0 ? <>{rows}</> : null;
}

/** The Details line: what the check said, with Remove for our rule or Check when nothing was checked. */
export function FirewallDetailValue({ c, t }: { c: FirewallController; t: T }) {
  const s = c.status;
  if (!s) {
    return (
      <span className="inline-flex items-center gap-2" data-firewall-detail="unchecked">
        {c.checking ? t('net.fw.checking') : t('net.fw.notChecked')}
        {!c.checking && <Button size="sm" variant="ghost" onClick={c.check} data-firewall-check>{t('net.fw.check')}</Button>}
      </span>
    );
  }
  const offer = firewallOffer(s);
  const text = offer.sentence ? t(offer.sentence.key, offer.sentence.vars) : '—';
  return (
    <span className="inline-flex items-center gap-2" data-firewall-detail={s.verdict}>
      {text}
      {s.verdict === 'covered' && s.platform === 'win32' && (
        <Button size="sm" variant="ghost" disabled={c.busy !== null} onClick={c.remove} data-firewall-remove>{t('net.fw.remove')}</Button>
      )}
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
 * this port means paired PCs must be invited again (A2A).
 */
export function ListenProblemView({ report, fallback, onUsePort, busy, repair, primary, listener, t }: {
  report: ListenProblemReport | null;
  fallback: string | null;
  onUsePort?: (port: number) => void;
  busy: boolean;
  repair: boolean;
  primary: boolean;
  listener: FirewallListener;
  t: T;
}) {
  const sentence = report ? listenProblemSentence(report) : null;
  const title = sentence ? t(sentence.key, sentence.vars) : fallback;
  if (!title) return null;
  const next = report?.suggestion ?? null;
  const actions = next !== null && onUsePort
    ? [
        <Button key="use" size="sm" variant={primary && !busy ? 'primary' : 'secondary'} disabled={busy} onClick={() => onUsePort(next)} data-listen-use-port={next}>
          {t('net.listen.usePort', { next })}
        </Button>,
      ]
    : [];
  return (
    <NoticeRow
      title={title}
      detail={[next !== null && repair ? t('net.listen.usePortRepair') : null]}
      actions={actions}
      testId={{ 'data-listen-problem': listener, 'data-problem': report?.problem.kind ?? 'raw' }}
    />
  );
}
