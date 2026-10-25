// === Why a listener could not open its port, in words a person can act on ===
//
// The three listeners another PC reaches (cross-PC A2A, the web/phone server
// with "Expose to network", LanLink) used to show Node's raw error code or
// message ("A2A: EADDRINUSE"). This module turns the code into a problem kind
// and parses the read-only Windows tools the daemon asks about the port:
// `netsh interface ipv4 show excludedportrange` (ports Windows reserves for
// Hyper-V, WSL and winnat), `netstat -ano` (who holds a port) and `tasklist`
// (that holder's image name).
//
// Pure: no imports, so the renderer can classify a code it was handed. The
// tools' headers are localized (CP949 on a Korean Windows), so the parsers
// read only the numeric and ASCII columns and ignore every other line.

/** What went wrong when a listener tried to bind its port. */
export type ListenProblem =
  | { kind: 'port-in-use'; port: number }
  | { kind: 'port-reserved'; port: number }
  | { kind: 'address-gone'; address: string | null }
  | { kind: 'other'; code: string };

/** An inclusive port range Windows keeps for itself. */
export interface ExcludedPortRange {
  start: number;
  end: number;
  /** Marked `*` by netsh: an administered exclusion (added by an admin or a policy). */
  administered: boolean;
}

export function portInRanges(port: number, ranges: readonly ExcludedPortRange[]): boolean {
  return ranges.some((r) => port >= r.start && port <= r.end);
}

/**
 * Classify a listen error code. On Windows EACCES means two different things:
 * the port lies in a range Windows reserved (Hyper-V/WSL/winnat), or another
 * socket holds it with SO_EXCLUSIVEADDRUSE. Only the first is "reserved", and
 * only when the port is inside a parsed excluded range; any other EACCES is a
 * port in use. On macOS and Linux EACCES below 1024 is a privileged port.
 */
export function classifyListenError(
  code: string | null | undefined,
  port: number,
  platform: string,
  excludedRanges: readonly ExcludedPortRange[] = [],
  address: string | null = null,
): ListenProblem {
  switch (code) {
    case 'EADDRINUSE':
      return { kind: 'port-in-use', port };
    case 'EACCES':
      if (platform === 'win32') {
        return portInRanges(port, excludedRanges) ? { kind: 'port-reserved', port } : { kind: 'port-in-use', port };
      }
      return port < 1024 ? { kind: 'port-reserved', port } : { kind: 'other', code };
    case 'EADDRNOTAVAIL':
      return { kind: 'address-gone', address };
    default:
      return { kind: 'other', code: code || 'unknown' };
  }
}

const RANGE_LINE = /^\s*(\d{1,5})\s+(\d{1,5})(\s+\*)?\s*$/;

/**
 * Parse `netsh interface ipv4 show excludedportrange protocol=tcp`. Only the
 * two-number rows count; the headers and the footnote are localized.
 */
export function parseExcludedPortRanges(text: string): ExcludedPortRange[] {
  const out: ExcludedPortRange[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RANGE_LINE.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start < 1 || end > 65535 || start > end) continue;
    out.push({ start, end, administered: Boolean(m[3]) });
  }
  return out;
}

/** One listening TCP socket from `netstat -ano`. */
export interface NetstatListener {
  address: string;
  port: number;
  pid: number;
}

// `  TCP    0.0.0.0:45660   0.0.0.0:0   LISTENING   1234` and the IPv6 shape
// `  TCP    [::]:45660      [::]:0      LISTENING   1234`. The state column is
// English on the localized Windows builds seen so far, but a listening socket
// is also the only kind whose foreign address is the zero address, so either
// mark is enough.
const NETSTAT_LINE = /^\s*TCP\s+(\[[^\]]*\]|[^\s:]+):(\d{1,5})\s+(\[[^\]]*\]|[^\s:]+):(\d{1,5}|\*)\s+(\S+)\s+(\d+)\s*$/i;

export function parseNetstatListeners(text: string): NetstatListener[] {
  const out: NetstatListener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = NETSTAT_LINE.exec(line);
    if (!m) continue;
    const zeroForeign = (m[3] === '0.0.0.0' || m[3] === '[::]') && (m[4] === '0' || m[4] === '*');
    if (m[5].toUpperCase() !== 'LISTENING' && !zeroForeign) continue;
    const address = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
    out.push({ address, port: Number(m[2]), pid: Number(m[6]) });
  }
  return out;
}

/** The PIDs listening on `port`, in the order netstat listed them, without repeats. */
export function holderPids(listeners: readonly NetstatListener[], port: number): number[] {
  const out: number[] = [];
  for (const l of listeners) if (l.port === port && l.pid > 0 && !out.includes(l.pid)) out.push(l.pid);
  return out;
}

/**
 * The image name from `tasklist /FI "PID eq N" /FO CSV /NH`
 * (`"node.exe","1234","Console","1","45,000 K"`). Null when there is no CSV row
 * (the "no tasks" line is localized) or the name is not printable ASCII: the
 * output is in the console codepage, and a garbled name is worse than none.
 */
export function parseTasklistImage(text: string, pid: number): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (!m || Number(m[2]) !== pid) continue;
    return /^[\x20-\x7e]{1,128}$/.test(m[1]) ? m[1] : null;
  }
  return null;
}

/** How far past the busy port a suggestion looks. */
export const FREE_PORT_SPAN = 20;

/**
 * The first port in port+1 … port+FREE_PORT_SPAN that is a registered port
 * (1024-65535), outside every excluded range, and that `isFree` accepts. A
 * suggestion only: the caller's trial bind is on loopback, which does not
 * prove the listener's real bind will succeed.
 */
export async function pickFreePort(
  port: number,
  excludedRanges: readonly ExcludedPortRange[],
  isFree: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let p = port + 1; p <= port + FREE_PORT_SPAN; p += 1) {
    if (p < 1024 || p > 65535 || portInRanges(p, excludedRanges)) continue;
    if (await isFree(p)) return p;
  }
  return null;
}

/** Who holds a busy port, as the daemon could tell. */
export type PortHolder =
  | { kind: 'process'; pid: number; image: string }
  | { kind: 'wmux'; pid: number }
  | { kind: 'unnamed'; pid: number };

/** The answer to `net.listenProblem`: the problem, its holder and a port to try instead. */
export interface ListenProblemReport {
  problem: ListenProblem;
  holder: PortHolder | null;
  /** A port that looked free; null when none did, or the problem is not about the port. */
  suggestion: number | null;
}

/** The i18n key and values of the one sentence that says why the port could not be used. */
export function listenProblemSentence(report: ListenProblemReport): { key: string; vars: Record<string, string | number> } | null {
  const p = report.problem;
  switch (p.kind) {
    case 'port-in-use': {
      const h = report.holder;
      if (h?.kind === 'process') return { key: 'net.listen.portInUse', vars: { port: p.port, process: h.image, pid: h.pid } };
      if (h?.kind === 'wmux') return { key: 'net.listen.portInUseWmux', vars: { port: p.port } };
      if (h) return { key: 'net.listen.portInUseUnknown', vars: { port: p.port, pid: h.pid } };
      return { key: 'net.listen.portInUseNoHolder', vars: { port: p.port } };
    }
    case 'port-reserved':
      return { key: 'net.listen.portReserved', vars: { port: p.port } };
    case 'address-gone':
      return { key: 'net.listen.addressGone', vars: {} };
    case 'other':
      return null;
  }
}
