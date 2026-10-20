/**
 * Working-directory detection helpers shared by PTYBridge.
 *
 * Extracted as pure functions (no Electron deps) so the two
 * notoriously fiddly parsers — OSC 7 URI decoding and prompt-pattern
 * scraping — have direct regression coverage. Both feed the same
 * `IPC.CWD_CHANGED` channel that drives the per-surface cwd shown in the tab
 * tooltip and the workspace "Working directories" menu.
 */

import os from 'node:os';
import { isPlausibleCwd, isUncOrDevicePath } from '../../shared/cwdShape';

const PROMPT_CWD_RE = /(?:PS\s+([A-Za-z]:\\[^>]*?)>)|(?:\w+@[\w.-]+:([^$]+?)\$)/g;

/**
 * Normalize an OSC 7 payload (`file://<host>/<path>`) into a native path.
 *
 * The shell hook emits `file://COMPUTERNAME/C:/Users/me` on Windows and
 * `file://host/home/me` on POSIX. The previous one-liner only stripped the
 * scheme+host, leaving Windows paths as `/C:/Users/me` — a leading slash with
 * forward slashes that renders as a broken path in the UI. We instead:
 *   - strip `file://<host>` (host is everything up to the first `/`),
 *   - percent-decode (paths with spaces arrive as `%20`),
 *   - collapse a Windows drive path (`/C:/Users/me` → `C:\Users\me`) by shape,
 *     not by host platform, so the result is correct regardless of where the
 *     code runs and is unit-testable without mocking `process.platform`.
 *   - reconstruct a UNC path: the hook emits a `\\server\share` cwd as
 *     `file://<host>///server/share` (the leading `//` of the UNC becomes the
 *     `///` after the host separator), which we collapse back to
 *     `\\server\share`.
 * POSIX paths (`/home/me`) pass through unchanged.
 *
 * Returns null, and the caller keeps the previous cwd, when the report is not
 * a local folder: a host other than this machine (`localHosts`, lowercase;
 * null skips the host check) or a network or device path.
 */
export function parseOsc7Cwd(data: string, localHosts: readonly string[] | null = machineHostnames()): string | null {
  const host = /^file:\/\/([^/]*)/.exec(data)?.[1] ?? '';
  if (localHosts && !localHosts.includes(host.toLowerCase())) return null;
  let p = data.replace(/^file:\/\/[^/]*/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed percent-encoding — keep the raw (still better than dropping it).
  }
  // Windows drive path by shape: "/C:/Users/me" → "C:\Users\me".
  if (/^\/[A-Za-z]:\//.test(p)) {
    return p.slice(1).replace(/\//g, '\\');
  }
  // Windows UNC path: "/" (host separator) + "//server/share" → "\\server\share".
  // Only a WSL distro's share is kept.
  if (/^\/\/\//.test(p)) {
    const unc = p.slice(1).replace(/\//g, '\\');
    return isUncOrDevicePath(unc) ? null : unc;
  }
  if (isUncOrDevicePath(p)) return null;
  // Deliberately NOT NFC-normalized here: this value doubles as the split-
  // inheritance spawn seed, and on normalization-SENSITIVE filesystems
  // (Linux ext4; NFS/macFUSE mounts on macOS) the NFC spelling may not name
  // the real directory — validateCwd would reject it and the new pane would
  // fall back to home (Codex review, PR #479). Raw spelling is kept for
  // state/spawning; the DISPLAY boundary (tab tooltip / working-directories
  // menu) normalizes for rendering instead — see displayPath().
  return p;
}

/**
 * The OSC 7 hosts that mean this machine: none, `localhost`, and every name
 * the machine has had while this process ran. The hooks send zsh `$HOST`,
 * bash `$HOSTNAME` or pwsh `$env:COMPUTERNAME` (the short NetBIOS name), and
 * a shell keeps the name it started with when macOS renames the host on a
 * network change.
 */
const seenHostnames = new Set<string>();
export function machineHostnames(): string[] {
  seenHostnames.add(os.hostname().toLowerCase());
  const netbios = process.env.COMPUTERNAME;
  if (netbios) seenHostnames.add(netbios.toLowerCase());
  return ['', 'localhost', ...seenHostnames];
}

/**
 * Scrape the current working directory from a (already ANSI-stripped) prompt
 * buffer, returning the LAST match or null when no prompt is present.
 *
 * Why the last match, not the first: after `cd`, the buffer routinely holds the
 * echoed command line carrying the OLD prompt (`PS C:\old> cd D:\new`) BEFORE
 * the freshly rendered new prompt (`PS D:\new>`). Taking the first match locked
 * onto the stale cwd — and because the caller clears the buffer on any match,
 * the new prompt was discarded, freezing the reported cwd at the shell's
 * startup directory. The last prompt in the buffer is always the live one.
 */
export function detectPromptCwd(
  clean: string,
  platform: NodeJS.Platform | string = process.platform,
): string | null {
  PROMPT_CWD_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = PROMPT_CWD_RE.exec(clean)) !== null) {
    last = m;
    // Guard against a zero-width match looping forever (defensive; the
    // patterns always consume, but lastIndex hygiene is cheap insurance).
    if (m.index === PROMPT_CWD_RE.lastIndex) PROMPT_CWD_RE.lastIndex++;
  }
  if (!last) return null;
  const cwd = (last[1] || last[2] || '').trim();
  if (!cwd) return null;
  // 오탐 방어(2026-07-20): 화면에 출력된 "PS C:\…>" 같은 텍스트를 프롬프트로
  // 오인해 POSIX 페인의 cwd를 Windows 경로로 덮어쓰던 사고 — 플랫폼에서
  // 존재할 수 없는 모양이면 버린다.
  if (!isPlausibleCwd(cwd, platform)) return null;
  return cwd;
}
