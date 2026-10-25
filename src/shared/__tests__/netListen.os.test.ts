import { describe, it, expect } from 'vitest';
import {
  classifyListenError,
  holderPids,
  listenProblemSentence,
  parseExcludedPortRanges,
  parseNetstatListeners,
  parseTasklistImage,
  pickFreePort,
  type ExcludedPortRange,
} from '../netListen';

// `netsh interface ipv4 show excludedportrange protocol=tcp` on the Korean
// Windows 11 dogfood box (2026-10-24): localized headers, one administered range.
const EXCLUDED_KO = [
  '',
  '프로토콜 tcp 포트 제외 범위',
  '',
  '시작 포트    끝 포트      ',
  '----------    --------      ',
  '      5357        5357      ',
  '     49181       49280      ',
  '     49281       49380      ',
  '     50000       50059     *',
  '',
  '* - 관리 포트 제외입니다.',
  '',
].join('\r\n');

const RANGES: ExcludedPortRange[] = parseExcludedPortRanges(EXCLUDED_KO);

describe('classifyListenError', () => {
  it('EADDRINUSE is a port in use on every platform', () => {
    expect(classifyListenError('EADDRINUSE', 45660, 'win32', RANGES)).toEqual({ kind: 'port-in-use', port: 45660 });
    expect(classifyListenError('EADDRINUSE', 45660, 'darwin')).toEqual({ kind: 'port-in-use', port: 45660 });
  });

  it('Windows EACCES inside an excluded range is reserved', () => {
    expect(classifyListenError('EACCES', 49200, 'win32', RANGES)).toEqual({ kind: 'port-reserved', port: 49200 });
    expect(classifyListenError('EACCES', 50059, 'win32', RANGES)).toEqual({ kind: 'port-reserved', port: 50059 });
  });

  it('Windows EACCES outside every range is a port in use (another socket holds it exclusively)', () => {
    expect(classifyListenError('EACCES', 45660, 'win32', RANGES)).toEqual({ kind: 'port-in-use', port: 45660 });
    expect(classifyListenError('EACCES', 49180, 'win32', RANGES)).toEqual({ kind: 'port-in-use', port: 49180 });
    expect(classifyListenError('EACCES', 49200, 'win32', [])).toEqual({ kind: 'port-in-use', port: 49200 });
  });

  it('unix EACCES below 1024 is a privileged (reserved) port, above it is something else', () => {
    expect(classifyListenError('EACCES', 80, 'linux')).toEqual({ kind: 'port-reserved', port: 80 });
    expect(classifyListenError('EACCES', 45660, 'darwin')).toEqual({ kind: 'other', code: 'EACCES' });
  });

  it('EADDRNOTAVAIL is an address that went away', () => {
    expect(classifyListenError('EADDRNOTAVAIL', 45651, 'win32', [], '10.0.0.5')).toEqual({ kind: 'address-gone', address: '10.0.0.5' });
  });

  it('anything else keeps its code', () => {
    expect(classifyListenError('ENOTFOUND', 1, 'win32')).toEqual({ kind: 'other', code: 'ENOTFOUND' });
    expect(classifyListenError(null, 1, 'win32')).toEqual({ kind: 'other', code: 'unknown' });
  });
});

describe('parseExcludedPortRanges', () => {
  it('reads the numeric rows of a localized table and the administered marker', () => {
    expect(RANGES).toEqual([
      { start: 5357, end: 5357, administered: false },
      { start: 49181, end: 49280, administered: false },
      { start: 49281, end: 49380, administered: false },
      { start: 50000, end: 50059, administered: true },
    ]);
  });

  it('ignores impossible rows', () => {
    expect(parseExcludedPortRanges('  70000  70001\n  10  5\n')).toEqual([]);
  });
});

describe('parseNetstatListeners', () => {
  const NETSTAT = [
    '',
    '활성 연결',
    '',
    '  프로토콜  로컬 주소              외부 주소              상태            PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1728',
    '  TCP    127.0.0.1:7681         0.0.0.0:0              LISTENING       4242',
    '  TCP    192.168.45.28:45651    0.0.0.0:0              ABHÖREN         5150',
    '  TCP    192.168.45.28:50123    20.1.2.3:443           ESTABLISHED     777',
    '  TCP    [::]:45660             [::]:0                 LISTENING       9001',
    '  TCP    [::1]:7681             [::]:0                 LISTENING       4242',
    '  UDP    0.0.0.0:5353           *:*                                    1234',
  ].join('\r\n');

  it('keeps listening rows (by state word or by the zero foreign address), IPv4 and IPv6', () => {
    expect(parseNetstatListeners(NETSTAT)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 1728 },
      { address: '127.0.0.1', port: 7681, pid: 4242 },
      { address: '192.168.45.28', port: 45651, pid: 5150 },
      { address: '::', port: 45660, pid: 9001 },
      { address: '::1', port: 7681, pid: 4242 },
    ]);
  });

  it('holderPids lists each PID once', () => {
    expect(holderPids(parseNetstatListeners(NETSTAT), 7681)).toEqual([4242]);
    expect(holderPids(parseNetstatListeners(NETSTAT), 1)).toEqual([]);
  });
});

describe('parseTasklistImage', () => {
  it('reads the image of the matching PID', () => {
    expect(parseTasklistImage('"node.exe","4242","Console","1","45,000 K"\r\n', 4242)).toBe('node.exe');
  });
  it('null for another PID, the localized no-task line, or a non-ASCII name', () => {
    expect(parseTasklistImage('"node.exe","4242","Console","1","45,000 K"', 1)).toBeNull();
    expect(parseTasklistImage('정보: 지정된 조건에 맞는 작업이 없습니다.', 4242)).toBeNull();
    expect(parseTasklistImage('"메모장.exe","4242","Console","1","4 K"', 4242)).toBeNull();
  });
});

describe('pickFreePort', () => {
  it('skips excluded ranges and ports the trial bind refuses', async () => {
    const busy = new Set([49180]);
    const tried: number[] = [];
    const port = await pickFreePort(49179, RANGES, async (p) => {
      tried.push(p);
      return !busy.has(p);
    });
    // 49180 is busy, 49181-49199 are excluded: nothing within 20.
    expect(port).toBeNull();
    expect(tried).toEqual([49180]);
  });

  it('returns the first free port above the busy one', async () => {
    expect(await pickFreePort(45660, RANGES, async (p) => p !== 45661)).toBe(45662);
  });

  it('stays inside 1024-65535', async () => {
    const tried: number[] = [];
    expect(await pickFreePort(65530, [], async (p) => { tried.push(p); return false; })).toBeNull();
    expect(Math.max(...tried)).toBe(65535);
  });
});

describe('listenProblemSentence', () => {
  it('names the holder when known', () => {
    expect(listenProblemSentence({ problem: { kind: 'port-in-use', port: 7681 }, holder: { kind: 'process', pid: 4, image: 'node.exe' }, suggestion: 7682 }))
      .toEqual({ key: 'net.listen.portInUse', vars: { port: 7681, process: 'node.exe', pid: 4 } });
    expect(listenProblemSentence({ problem: { kind: 'port-in-use', port: 7681 }, holder: { kind: 'wmux', pid: 4 }, suggestion: null })?.key)
      .toBe('net.listen.portInUseWmux');
    expect(listenProblemSentence({ problem: { kind: 'port-in-use', port: 7681 }, holder: { kind: 'unnamed', pid: 4 }, suggestion: null })?.key)
      .toBe('net.listen.portInUseUnknown');
    expect(listenProblemSentence({ problem: { kind: 'port-in-use', port: 7681 }, holder: null, suggestion: null })?.key)
      .toBe('net.listen.portInUseNoHolder');
  });

  it('has no sentence for an unclassified code', () => {
    expect(listenProblemSentence({ problem: { kind: 'other', code: 'X' }, holder: null, suggestion: null })).toBeNull();
  });
});
