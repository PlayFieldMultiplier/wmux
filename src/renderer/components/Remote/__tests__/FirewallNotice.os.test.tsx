/**
 * Remote pairing's firewall and port notices. Node env: the pure views render
 * through renderToStaticMarkup with a controller object, as each surface
 * (Remote page, invite tab, Settings › LAN, Share & pair) passes one.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FirewallDetailActions, FirewallDetailValue, FirewallNoticeView, ListenProblemView, type FirewallController } from '../FirewallNotice';
import { VERDICT_PRECEDENCE, inapplicableStatus, type InboundStatusView, type InboundVerdict } from '../../../../shared/netFirewall';
import type { ListenProblemReport } from '../../../../shared/netListen';

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars && Object.keys(vars).length > 0 ? `${key}(${Object.values(vars).join(',')})` : key;
const noop = (): void => undefined;

function status(over: Partial<InboundStatusView> = {}): InboundStatusView {
  return {
    ...inapplicableStatus('a2a', 'win32', 'C:\\w\\app-1.0.0\\wmux.exe', 1),
    applicable: true,
    port: 45660,
    verdict: 'not-covered',
    ruleIds: { allow: 'wmux-a2a-1a2b3c4d-allow', pubblock: 'wmux-a2a-1a2b3c4d-pubblock' },
    elevation: 'consent',
    ...over,
  };
}
function ctl(over: Partial<FirewallController> = {}): FirewallController {
  return {
    status: status(),
    checking: false,
    readFailed: false,
    busy: null,
    outcome: null,
    fixed: false,
    copied: false,
    settled: 0,
    check: noop,
    fix: noop,
    remove: noop,
    copyDetails: noop,
    open: noop,
    ...over,
  };
}
const view = (c: FirewallController, opts: { primary?: boolean; quiet?: boolean; ownCheck?: boolean; seenAt?: number | null; live?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(FirewallNoticeView, { c, listener: 'a2a', primary: opts.primary ?? true, quiet: opts.quiet ?? false, ownCheck: opts.ownCheck, seenAt: opts.seenAt, live: opts.live, t }));
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('FirewallNoticeView — one row per verdict', () => {
  const NOTICE: InboundVerdict[] = ['not-covered', 'stale-after-update', 'blocked-by-rule', 'public-network', 'domain-network', 'policy-managed', 'inbound-blocked-all', 'third-party', 'unknown'];
  for (const verdict of VERDICT_PRECEDENCE) {
    it(`${verdict}`, () => {
      const html = view(ctl({ status: status({ verdict, publicNetworks: ['Wi-Fi'] }) }));
      if (NOTICE.includes(verdict)) {
        expect(count(html, 'data-firewall-notice="a2a"')).toBe(1);
        expect(html).toContain(`data-verdict="${verdict}"`);
        expect(html).toContain('data-tone="warning"');
      } else {
        expect(html).not.toContain('data-firewall-notice');
      }
      // The Fix appears for exactly the fixable verdicts.
      expect(html.includes('data-firewall-fix'), verdict).toBe(verdict === 'not-covered' || verdict === 'stale-after-update');
      // Caution yellow at most; never the needs-you orange.
      expect(html).not.toMatch(/attention/);
    });
  }

  it('covered and firewall-off are muted lines, not notices', () => {
    expect(view(ctl({ status: status({ verdict: 'covered' }) }))).toContain('net.fw.allowed(45660)');
    const off = view(ctl({ status: status({ verdict: 'firewall-off' }) }));
    expect(off).toContain('net.fw.off');
    expect(off).not.toContain('data-firewall-notice');
  });

  it('quiet (the Remote page) hides the steady allowed line and Checking…, but not what a Fix just did', () => {
    expect(view(ctl({ status: status({ verdict: 'covered' }) }), { quiet: true })).toBe('');
    expect(view(ctl({ status: null, checking: true }), { quiet: true })).toBe('');
    const after = view(ctl({ status: status({ verdict: 'covered' }), outcome: { kind: 'ok' }, fixed: true }), { quiet: true });
    expect(after).toContain('net.fw.allowed(45660)');
    expect(after).toContain('net.fw.nowRetry');
  });

  it('another PC reaching this one is said with its time', () => {
    expect(view(ctl({ status: status({ verdict: 'covered', inboundSeenAt: Date.UTC(2026, 9, 25, 5, 2) }) }))).toContain('net.fw.inboundSeen(');
  });

  it('"reached" comes from the listener\'s live time too, not only from the last check', () => {
    // After a Fix the probe ran before the other PC connected; the polled status knows better.
    const after = ctl({ status: status({ verdict: 'covered', inboundSeenAt: null }), outcome: { kind: 'ok' }, fixed: true });
    expect(view(after, { quiet: true })).not.toContain('net.fw.inboundSeen(');
    expect(view(after, { quiet: true, seenAt: Date.UTC(2026, 9, 25, 5, 2) })).toContain('net.fw.inboundSeen(');
  });

  it('a failed read hides the old verdict: the could-not-read row with Check, whatever was shown before', () => {
    const html = view(ctl({ status: status({ verdict: 'covered' }), readFailed: true }));
    expect(html).toContain('net.fw.unknown');
    expect(html).toContain('data-firewall-check');
    expect(html).not.toContain('net.fw.allowed');
  });

  it('rows are live by themselves, except inside a surface\'s live container', () => {
    expect(view(ctl())).toContain('role="status"');
    expect(view(ctl(), { live: false })).not.toContain('role="status"');
    expect(view(ctl({ status: status({ verdict: 'covered' }) }), { live: false })).not.toContain('role="status"');
  });

  it('a surface with its own Check (the invite tab) gets neither "Checking…" nor a second Check', () => {
    expect(view(ctl({ status: null, checking: true }), { ownCheck: true })).toBe('');
    expect(view(ctl({ status: null, readFailed: true }), { ownCheck: true })).not.toContain('data-firewall-check');
    expect(view(ctl({ status: status({ verdict: 'unknown' }) }), { ownCheck: true })).not.toContain('data-firewall-check');
  });
});

describe('the Fix and the one-primary rule', () => {
  it('primary only when the surface allows it and nothing is in flight', () => {
    expect(view(ctl())).toMatch(/ui-btn-primary[^>]*data-firewall-fix/);
    expect(view(ctl(), { primary: false })).not.toContain('ui-btn-primary');
    expect(view(ctl({ busy: 'fix' }))).not.toContain('ui-btn-primary');
    expect(view(ctl({ checking: true }))).not.toContain('ui-btn-primary');
    expect(count(view(ctl()), 'ui-btn-primary')).toBe(1);
  });

  it('while it runs the Fix says so and stays focusable: aria-disabled and aria-busy, not disabled', () => {
    const html = view(ctl({ busy: 'fix' }));
    expect(html).toContain('net.fw.working');
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-busy="true"[^>]*data-firewall-fix/);
    expect(html).not.toMatch(/disabled=""[^>]*data-firewall-fix/);
  });

  it('a click refused because another change runs says so', () => {
    expect(view(ctl({ outcome: { kind: 'refused', refusal: 'busy' } }))).toContain('net.fw.busy');
    expect(view(ctl({ outcome: { kind: 'refused', refusal: 'changed' } }))).not.toContain('net.fw.busy');
  });

  it('a change that ran but whose check after it failed says so, with Check', () => {
    const html = view(ctl({ status: null, readFailed: true, outcome: { kind: 'ok' } }));
    expect(html).toContain('net.fw.okUnchecked');
    expect(html).toContain('data-firewall-check');
  });

  it('the hint names the prompt Windows (or macOS) will show', () => {
    expect(view(ctl())).toContain('net.fw.allowHintConsent(45660)');
    expect(view(ctl({ status: status({ elevation: 'credential' }) }))).toContain('net.fw.allowHintCredential(45660)');
    expect(view(ctl({ status: status({ elevation: 'elevated' }) }))).toContain('net.fw.allowHintElevated(45660)');
    expect(view(ctl({ status: status({ platform: 'darwin', ruleIds: null }) }))).toContain('net.fw.allowHintMac');
  });

  it('a refused program gets Copy details, never the Fix', () => {
    const html = view(ctl({ status: status({ refusal: 'node-daemon' }) }));
    expect(html).toContain('net.fw.nodeDaemon');
    expect(html).toContain('data-firewall-copy');
    expect(html).not.toContain('data-firewall-fix');
  });

  it('a declined prompt says so; with a credential prompt it adds the no-admin line and Copy details', () => {
    const consent = view(ctl({ outcome: { kind: 'cancelled' } }));
    expect(consent).toContain('net.fw.cancelled');
    expect(consent).not.toContain('net.fw.cancelledNoAdmin');
    const credential = view(ctl({ outcome: { kind: 'cancelled' }, status: status({ elevation: 'credential' }) }));
    expect(credential).toContain('net.fw.cancelledNoAdmin');
    expect(credential).toContain('data-firewall-copy');
  });

  it('a Fix whose public block failed names that step even though the check says the Allow is there', () => {
    const html = view(ctl({ status: status({ verdict: 'covered' }), outcome: { kind: 'failed', stage: 'pubblock', code: 12 } }), { quiet: true });
    expect(html).toContain('net.fw.allowed(45660)');
    expect(html).toContain('net.fw.failed(net.fw.stage.pubblock)');
    expect(html).not.toContain('net.fw.nowRetry');
  });

  it('a change still running when the wait ended says so', () => {
    expect(view(ctl({ outcome: { kind: 'running' } }))).toContain('net.fw.stillRunning');
  });

  it('a failed stage is named, never stderr', () => {
    expect(view(ctl({ outcome: { kind: 'failed', stage: 'pubblock', code: 12 } }))).toContain('net.fw.failed(net.fw.stage.pubblock)');
    expect(view(ctl({ outcome: { kind: 'failed', stage: null, code: 5 } }))).toContain('net.fw.failed(5)');
  });

  it('a declined macOS admin sheet is not called a Windows request', () => {
    const mac = view(ctl({ outcome: { kind: 'cancelled' }, status: status({ platform: 'darwin', ruleIds: null }) }));
    expect(mac).toContain('net.fw.cancelledMac');
    expect(mac).not.toMatch(/net\.fw\.cancelled(?!Mac)/);
  });
});

describe('explain-only actions', () => {
  it('public network: the network named, Open network settings, and the mixed line', () => {
    const html = view(ctl({ status: status({ verdict: 'public-network', publicNetworks: ['Wi-Fi'] }) }));
    expect(html).toContain('net.fw.publicNetwork(Wi-Fi)');
    expect(html).toContain('data-firewall-open="network"');
    const mixed = view(ctl({ status: status({ verdict: 'covered', okNetworks: ['Tailscale'], publicNetworks: ['Wi-Fi'] }) }));
    expect(mixed).toContain('net.fw.partlyPublic(Tailscale,Wi-Fi)');
  });

  it('a Block rule: Open Windows Firewall; unknown: Check', () => {
    expect(view(ctl({ status: status({ verdict: 'blocked-by-rule' }) }))).toContain('data-firewall-open="firewall"');
    expect(view(ctl({ status: status({ verdict: 'unknown' }) }))).toContain('data-firewall-check');
    expect(view(ctl({ status: null, readFailed: true }))).toContain('net.fw.unknown');
  });
});

describe('exposedPublic', () => {
  it('its own warning row with Open Windows Firewall; after a Fix it says the port is blocked on public networks', () => {
    const html = view(ctl({ status: status({ verdict: 'covered-by-prompt', exposedPublic: true }) }));
    expect(count(html, 'data-firewall-exposed="a2a"')).toBe(1);
    expect(html).toContain('net.fw.exposedPublic');
    expect(html).not.toContain('net.fw.exposedPublicFixed');
    const fixed = view(ctl({ status: status({ verdict: 'covered', exposedPublic: true, publicBlocked: true }) }));
    expect(fixed).toContain('net.fw.exposedPublicFixed(45660)');
  });

  it('never on macOS', () => {
    expect(view(ctl({ status: status({ platform: 'darwin', exposedPublic: true }) }))).not.toContain('data-firewall-exposed');
  });
});

describe('Details: the Firewall value and its actions', () => {
  const detail = (c: FirewallController, seenAt?: number | null) => renderToStaticMarkup(createElement(FirewallDetailValue, { c, seenAt, t }));
  const actions = (c: FirewallController) => renderToStaticMarkup(createElement(FirewallDetailActions, { c, t }));

  it('the value: Not checked, the verdict, a failed read, never a bare dash', () => {
    expect(detail(ctl({ status: null }))).toContain('net.fw.notChecked');
    expect(detail(ctl({ status: status({ verdict: 'covered' }) }))).toContain('net.fw.allowed(45660)');
    expect(detail(ctl({ status: status({ verdict: 'firewall-off' }) }))).toContain('net.fw.off');
    expect(detail(ctl({ status: status({ verdict: 'covered' }), readFailed: true }))).toContain('net.fw.unknown');
    expect(detail(ctl({ status: inapplicableStatus('a2a', 'win32', 'C:\\w\\wmux.exe', 1) as InboundStatusView }))).toContain('net.fw.notChecked');
    expect(detail(ctl({ status: status({ verdict: 'covered' }) }))).not.toContain('—');
    expect(detail(ctl({ status: status({ verdict: 'covered' }) }), Date.UTC(2026, 9, 25, 5, 2))).toContain('net.fw.inboundSeen(');
  });

  it('the actions: Check firewall always, Remove only for our rule, with its own name', () => {
    for (const verdict of VERDICT_PRECEDENCE) expect(actions(ctl({ status: status({ verdict }) })), verdict).toContain('data-firewall-check');
    expect(actions(ctl({ status: null }))).toContain('data-firewall-check');
    const covered = actions(ctl({ status: status({ verdict: 'covered' }) }));
    expect(covered).toContain('data-firewall-remove');
    expect(covered).toContain('aria-label="net.fw.removeAria"');
    expect(actions(ctl({ status: status({ verdict: 'covered-by-prompt' }) }))).not.toContain('data-firewall-remove');
    expect(actions(ctl({ status: status({ verdict: 'covered', platform: 'darwin', ruleIds: null }) }))).not.toContain('data-firewall-remove');
    expect(actions(ctl({ status: status({ verdict: 'covered' }), busy: 'remove' }))).toContain('net.fw.working');
  });
});

describe('ListenProblemView', () => {
  const lp = (report: ListenProblemReport | null, over: { repair?: boolean; fallback?: string | null; primary?: boolean } = {}) =>
    renderToStaticMarkup(createElement(ListenProblemView, {
      report,
      fallback: over.fallback ?? null,
      onUsePort: noop,
      busy: false,
      repair: over.repair ?? true,
      primary: over.primary ?? false,
      listener: 'a2a',
      t,
    }));

  it('names the holder and offers the free port, with the re-invite line for A2A', () => {
    const html = lp({ problem: { kind: 'port-in-use', port: 45660 }, holder: { kind: 'process', pid: 42, image: 'node.exe' }, suggestion: 45661 });
    expect(html).toContain('net.listen.portInUse(45660,node.exe,42)');
    expect(html).toContain('data-listen-use-port="45661"');
    expect(html).toContain('net.listen.usePort(45661)');
    expect(html).toContain('net.listen.usePortRepair');
    expect(lp({ problem: { kind: 'port-in-use', port: 7681 }, holder: null, suggestion: 7682 }, { repair: false })).not.toContain('net.listen.usePortRepair');
  });

  it('reserved, denied and gone-address sentences; no port, no button', () => {
    expect(lp({ problem: { kind: 'port-reserved', port: 50000 }, holder: null, suggestion: null })).toContain('net.listen.portReserved(50000)');
    expect(lp({ problem: { kind: 'port-denied', port: 50000 }, holder: null, suggestion: 50001 })).toContain('net.listen.portDenied(50000)');
    expect(lp({ problem: { kind: 'port-in-use', port: 50000 }, holder: { kind: 'self', pid: 1 }, suggestion: null })).toContain('net.listen.portInUseSelf(50000)');
    const gone = lp({ problem: { kind: 'address-gone', address: '10.0.0.5' }, holder: null, suggestion: null });
    expect(gone).toContain('net.listen.addressGone');
    expect(gone).not.toContain('data-listen-use-port');
  });

  it('the raw reason until the explanation arrives; nothing without either', () => {
    expect(lp(null, { fallback: 'Not listening: EADDRINUSE' })).toContain('Not listening: EADDRINUSE');
    expect(lp(null)).toBe('');
  });
});
