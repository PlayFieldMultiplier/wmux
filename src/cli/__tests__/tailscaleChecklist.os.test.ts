import { describe, expect, it } from 'vitest';
import {
  checkTailscale,
  classifyStatusError,
  classifyTailscaleChecklist,
  fixtureTailscaleExec,
  tailscaleAppLaunch,
  tailscaleCandidates,
  type TailscaleChecklist,
  type TailscaleExec,
} from '../tailscale';

/**
 * The Remote page's four Tailscale checks. Every shell-out goes through the
 * injected exec seam; nothing here spawns a binary.
 */

const SELF = { HostName: 'laptop', DNSName: 'laptop.tail1234.ts.net.', Online: true, TailscaleIPs: ['100.101.0.1'] };
const DESK = { HostName: 'desk', DNSName: 'desk.tail1.ts.net.', Online: true, TailscaleIPs: ['100.101.12.4'] };
const PHONE = { HostName: 'phone', DNSName: 'phone.tail1.ts.net.', Online: false, TailscaleIPs: ['100.101.12.9'] };

function status(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ BackendState: 'Running', Self: SELF, Peer: { k1: DESK, k2: PHONE }, ...over });
}

function err(props: { code?: string; stderr?: string }): Error {
  return Object.assign(new Error('Command failed'), props);
}

const states = (c: TailscaleChecklist) => c.items.map((i) => `${i.id}:${i.state}`);
const failed = (c: TailscaleChecklist) => c.items.find((i) => i.state === 'fail');

describe('classifyTailscaleChecklist — one test per check, pass and fail', () => {
  it('installed: passes when the CLI ran; fails with the download page when it was not found', () => {
    expect(classifyTailscaleChecklist({ stdout: status() }).items[0]).toEqual({ id: 'installed', state: 'pass' });
    const c = classifyTailscaleChecklist({ error: err({ code: 'ENOENT' }) });
    expect(failed(c)).toEqual({ id: 'installed', state: 'fail', reason: 'not-installed', fix: 'download' });
    // What comes after a failure cannot be known yet: unchecked, not failed, and no second button.
    expect(states(c)).toEqual(['installed:fail', 'signed-in:unchecked', 'self:unchecked', 'peer:unchecked']);
  });

  it('signed in: passes when Running; fails with "sign in" when logged out, and "open" when the daemon is not running', () => {
    expect(classifyTailscaleChecklist({ stdout: status() }).items[1].state).toBe('pass');
    expect(failed(classifyTailscaleChecklist({ stdout: status({ BackendState: 'NeedsLogin' }) })))
      .toEqual({ id: 'signed-in', state: 'fail', reason: 'signed-out', fix: 'sign-in' });
    const off = classifyTailscaleChecklist({ error: err({ stderr: 'failed to connect to local Tailscale service; is Tailscale running?' }) });
    expect(states(off)).toEqual(['installed:pass', 'signed-in:fail', 'self:unchecked', 'peer:unchecked']);
    expect(failed(off)).toMatchObject({ reason: 'not-running', fix: 'open-app' });
  });

  it('this PC visible: passes when Running and online; fails with "open" when stopped, offline or awaiting approval', () => {
    expect(classifyTailscaleChecklist({ stdout: status() }).items[2].state).toBe('pass');
    for (const [over, reason] of [
      [{ BackendState: 'Stopped' }, 'stopped'],
      [{ Self: { ...SELF, Online: false } }, 'offline'],
      [{ BackendState: 'Starting' }, 'offline'],
      [{ BackendState: 'NeedsMachineAuth' }, 'needs-approval'],
    ] as const) {
      const c = classifyTailscaleChecklist({ stdout: status(over) });
      expect(failed(c)).toEqual({ id: 'self', state: 'fail', reason, fix: 'open-app' });
      expect(c.items[3].state).toBe('unchecked');
    }
  });

  it('peer visible: any online device passes with none named; a named one must be found and online', () => {
    const any = classifyTailscaleChecklist({ stdout: status() });
    expect(any.ok).toBe(true);
    expect(any.peersOnline).toBe(1);
    expect(any.selfName).toBe('laptop');
    // Named by MagicDNS name, its first label, or tailnet address.
    for (const peer of ['desk.tail1.ts.net', 'DESK', '100.101.12.4', 'desk.tail1.ts.net.']) {
      expect(classifyTailscaleChecklist({ stdout: status() }, peer).ok).toBe(true);
    }
    expect(failed(classifyTailscaleChecklist({ stdout: status() }, 'phone.tail1.ts.net')))
      .toEqual({ id: 'peer', state: 'fail', reason: 'peer-offline', fix: 'peer-help' });
    expect(failed(classifyTailscaleChecklist({ stdout: status() }, 'nas.tail1.ts.net')))
      .toMatchObject({ id: 'peer', reason: 'no-peer', fix: 'peer-help' });
    expect(failed(classifyTailscaleChecklist({ stdout: status({ Peer: { k2: PHONE } }) })))
      .toMatchObject({ id: 'peer', reason: 'no-peer' });
  });

  it('an unreadable status fails "signed in" as unreadable (which never blocks a connection)', () => {
    expect(failed(classifyTailscaleChecklist({ stdout: 'not json' }))).toMatchObject({ id: 'signed-in', reason: 'unreadable' });
    expect(failed(classifyTailscaleChecklist({ error: err({ stderr: 'something else' }) }))).toMatchObject({ reason: 'unreadable' });
    expect(classifyStatusError(err({ stderr: 'something else' }))).toBe('status-unreadable');
  });
});

describe('nothing runs `tailscale up` or an installer', () => {
  it('every checklist state is read with exactly one `status --json`, and nothing else', async () => {
    const outputs: Array<string | Error> = [
      status(), status({ BackendState: 'NeedsLogin' }), status({ BackendState: 'Stopped' }),
      err({ stderr: 'failed to connect to local tailscaled' }), err({ code: 'ENOENT' }),
    ];
    for (const out of outputs) {
      const calls: string[][] = [];
      const exec: TailscaleExec = async (_cmd, args) => {
        calls.push(args);
        if (out instanceof Error) throw out;
        return { stdout: out, stderr: '' };
      };
      await checkTailscale({ exec, peer: 'desk' });
      // ENOENT walks the candidate paths; every one of them is asked the same read.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((a) => a.join(' ') === 'status --json')).toBe(true);
    }
  });

  it('the dev fixture answers only `status --json` and refuses every other command', async () => {
    const exec = fixtureTailscaleExec('/fixture.json', async () => status());
    const opts = { timeout: 1, windowsHide: true, maxBuffer: 1 };
    expect((await exec('tailscale', ['status', '--json'], opts)).stdout).toBe(status());
    await expect(exec('tailscale', ['up'], opts)).rejects.toThrow(/read-only/);
    await expect(exec('tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.1:7681'], opts)).rejects.toThrow(/read-only/);
    const missing = fixtureTailscaleExec('/missing.json', async () => { throw new Error('nope'); });
    await expect(missing('tailscale', ['status', '--json'], opts)).rejects.toMatchObject({ code: 'ENOENT' });
    const stopped = fixtureTailscaleExec('/f', async () => 'stderr: failed to connect to local Tailscale service');
    expect(failed(await checkTailscale({ exec: stopped }))).toMatchObject({ reason: 'not-running' });
  });
});

describe('platform paths', () => {
  it('Windows: the PATH name, then Program Files (and the 64-bit one from a 32-bit process)', () => {
    expect(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files' })).toEqual([
      'tailscale.exe',
      'C:\\Program Files\\Tailscale\\tailscale.exe',
    ]);
    expect(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' })).toEqual([
      'tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
      'C:\\Program Files\\Tailscale\\tailscale.exe',
    ]);
    expect(tailscaleCandidates('win32', {})[1]).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
  });

  it('macOS: PATH (Homebrew via the exec env), then the app bundle, then the per-user Applications bundle', () => {
    expect(tailscaleCandidates('darwin', { HOME: '/Users/someone' })).toEqual([
      'tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/Users/someone/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ]);
    expect(tailscaleCandidates('linux', {})).toEqual(['tailscale']);
  });

  it('opening the app: `open -a` on macOS, the tray app under Program Files on Windows, nothing on Linux', () => {
    expect(tailscaleAppLaunch('darwin', {})).toEqual([{ cmd: 'open', args: ['-a', 'Tailscale'] }]);
    expect(tailscaleAppLaunch('win32', { ProgramFiles: 'D:\\Apps' })).toEqual([
      { cmd: 'D:\\Apps\\Tailscale\\tailscale-ipn.exe', args: [] },
    ]);
    expect(tailscaleAppLaunch('linux', {})).toBeNull();
  });
});
