/**
 * Cross-PC A2A listener in Settings › LAN. Node env, no DOM: the pure
 * `A2aRemoteView` renders through renderToStaticMarkup (LanLinkSection.test.tsx
 * pattern). Inviting, joining and the paired PCs moved to the Remote page
 * (2026-10-22); this section keeps only the listener.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { A2aRemoteView, fingerprintPrefix, formatRemaining, type A2aRemoteViewProps } from '../A2aRemoteSection';
import { en } from '../../../i18n/locales/en';
import type { A2aRemoteJoinError } from '../../../../shared/rpc';

const tStub = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');

function props(over: Partial<A2aRemoteViewProps> = {}): A2aRemoteViewProps {
  return {
    status: {
      enabled: true, port: 45660, listening: true, hostId: '11111111-1111-4111-8111-111111111111',
      name: 'DESK-PC', fingerprint256: FP, lastError: null,
    },
    platform: 'darwin', fingerprintCopied: false, onCopyFingerprint: () => undefined,
    busy: false, onToggleEnabled: () => undefined, portDraft: '45660', onPortDraft: () => undefined, onPortCommit: () => undefined,
    error: null, t: tStub,
    ...over,
  };
}

const render = (p: A2aRemoteViewProps): string => renderToStaticMarkup(createElement(A2aRemoteView, p));

describe('A2aRemoteView', () => {
  it('shows this PC’s name, the first 16 fingerprint characters and the listening port', () => {
    const html = render(props());
    expect(html).toContain('DESK-PC');
    // Visible text is cut on a byte boundary with an ellipsis; the full value is the title.
    expect(html).toContain('>10:11:12:13:14:15…</span>');
    expect(html).toContain(`title="${FP}"`);
    expect(html).toContain('settings.a2aRemoteFingerprintCopy');
    expect(html).toContain('settings.a2aRemoteListening(45660)');
  });

  it('keeps only the listener: no invite, join or list of PCs (they live on the Remote page)', () => {
    const html = render(props());
    expect(html).toContain('settings.a2aRemoteEnable');
    expect(html).toContain('settings.a2aRemotePort');
    for (const gone of ['settings.a2aRemoteInviteButton', 'settings.a2aRemoteJoin', 'settings.a2aRemoteHosts', 'settings.a2aRemotePeers']) {
      expect(html).not.toContain(gone);
    }
    expect(html).not.toContain('ui-btn-primary');
  });

  it('says why it does not listen, and a failed port change while the old port keeps serving', () => {
    expect(render(props({ status: { ...props().status, listening: false, lastError: 'EADDRINUSE' } })))
      .toContain('settings.a2aRemoteNotListening(EADDRINUSE)');
    expect(render(props({ status: { ...props().status, lastError: 'EADDRINUSE' } })))
      .toContain('settings.a2aRemotePortFailed(EADDRINUSE,45660)');
  });

  it('words the port hint for the platform', () => {
    expect(render(props({ platform: 'darwin' }))).toContain('settings.a2aRemotePortDesc.darwin');
    expect(render(props({ platform: 'win32' }))).toContain('settings.a2aRemotePortDesc.win32');
    for (const p of ['darwin', 'win32', 'linux']) expect(en).toHaveProperty([`settings.a2aRemotePortDesc.${p}`]);
    expect(en['settings.a2aRemotePortDesc.darwin']).not.toMatch(/Windows/);
  });
});

describe('join error messages (used by Connect a PC)', () => {
  it('has an English message for every join error', () => {
    const codes: A2aRemoteJoinError[] = [
      'invite-invalid', 'self', 'fingerprint-mismatch', 'connect-refused', 'timeout', 'not-found',
      'code-expired', 'code-invalid', 'already-paired', 'rate-limited', 'protocol', 'failed',
    ];
    for (const error of codes) expect(en).toHaveProperty([`settings.a2aRemoteJoinError.${error}`]);
    // The identity-changed case tells the user to get a new invite.
    expect(en['settings.a2aRemoteJoinError.fingerprint-mismatch']).toMatch(/new invite/);
  });
});

describe('A2aRemoteView — port and firewall notices', () => {
  const notice = (id: string) => createElement('div', { 'data-slot': id });
  it('a bind failure shows the explained notice in place of the raw note', () => {
    const html = render(props({
      status: { ...props().status, listening: false, lastError: 'EADDRINUSE', lastErrorCode: 'EADDRINUSE', lastErrorPort: 45660 },
      listenNotice: notice('listen'),
      firewallNotice: notice('firewall'),
    }));
    expect(html).toContain('data-slot="listen"');
    expect(html).not.toContain('settings.a2aRemoteNotListening');
    // Nothing listens, so there is no firewall to check.
    expect(html).not.toContain('data-slot="firewall"');
  });

  it('a listener shows its firewall check; a failed port change keeps the still-listening note', () => {
    expect(render(props({ firewallNotice: notice('firewall') }))).toContain('data-slot="firewall"');
    const html = render(props({
      status: { ...props().status, listening: true, lastError: 'EADDRINUSE', lastErrorCode: 'EADDRINUSE', lastErrorPort: 45661 },
      listenNotice: notice('listen'),
    }));
    expect(html).toContain('data-slot="listen"');
    expect(html).toContain('settings.a2aRemotePortFailed');
  });
});

describe('fingerprintPrefix', () => {
  it('cuts on a byte boundary', () => {
    expect(fingerprintPrefix('03:5C:37:EC:BF:1A:22:33')).toBe('03:5C:37:EC:BF:1A…');
    expect(fingerprintPrefix('03:5C')).toBe('03:5C');
  });
});

describe('formatRemaining', () => {
  it('renders m:ss', () => {
    expect(formatRemaining(600)).toBe('10:00');
    expect(formatRemaining(61)).toBe('1:01');
    expect(formatRemaining(-3)).toBe('0:00');
  });
});
