// What a connection does with Tailscale's state: stop at once only for an
// address that is surely Tailscale's; otherwise try, and name Tailscale only
// if the other PC is not reached.
import { describe, expect, it } from 'vitest';
import { judgeTailnet } from '../tailnetCheck';
import type { TailscaleChecklist } from '../../../../shared/web';

type Reason = 'not-installed' | 'not-running' | 'unreadable' | 'offline' | 'no-peer' | 'peer-offline';
const AT: Record<Reason, number> = { 'not-installed': 0, 'not-running': 1, unreadable: 1, offline: 2, 'no-peer': 3, 'peer-offline': 3 };
const IDS = ['installed', 'signed-in', 'self', 'peer'] as const;

function failing(reason: Reason): TailscaleChecklist {
  const at = AT[reason];
  return {
    items: IDS.map((id, i) => (i < at ? { id, state: 'pass' as const } : i === at
      ? { id, state: 'fail' as const, reason, fix: 'open-app' as const }
      : { id, state: 'unchecked' as const })),
    ok: false,
  };
}

describe('judgeTailnet', () => {
  it('a *.ts.net name with Tailscale off is held back; so is an address Tailscale lists as an offline peer', () => {
    expect(judgeTailnet('desk.tail1.ts.net', failing('not-running')).held?.text).toMatch(/off/);
    expect(judgeTailnet('100.101.12.4', failing('peer-offline')).held).not.toBeNull();
  });

  it('another 100.64/10 address is tried: the reason waits for a failed connect; no-peer or no Tailscale at all clears it entirely', () => {
    const off = judgeTailnet('100.92.4.7', failing('not-running'));
    expect(off.held).toBeNull();
    expect(off.ifUnreachable?.text).toMatch(/off/);
    expect(judgeTailnet('100.92.4.7', failing('no-peer'))).toEqual({ held: null, ifUnreachable: null });
    // Never "Download Tailscale" for an address another overlay may own.
    expect(judgeTailnet('100.92.4.7', failing('not-installed'))).toEqual({ held: null, ifUnreachable: null });
    expect(judgeTailnet('desk.tail1.ts.net', failing('not-installed')).held?.fix).toBe('open-app');
  });

  it('an unreadable status (the 5 s abort) and this PC offline from the control server never block', () => {
    for (const reason of ['unreadable', 'offline'] as const) {
      expect(judgeTailnet('desk.tail1.ts.net', failing(reason))).toEqual({ held: null, ifUnreachable: null });
    }
    expect(judgeTailnet('desk.tail1.ts.net', null)).toEqual({ held: null, ifUnreachable: null });
    expect(judgeTailnet('192.168.0.12', failing('not-running'))).toEqual({ held: null, ifUnreachable: null });
  });
});
