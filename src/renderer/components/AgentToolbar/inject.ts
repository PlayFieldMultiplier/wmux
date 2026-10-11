import { terminalRegistry } from '../../hooks/useTerminal';
import { useStore } from '../../stores';
import { quotePosixPath } from '../../../shared/imagePaste';
import { pastePtyChunked, type TerminalModesLike } from '../../utils/clipboardChunk';

/** C0 (incl. \t \n \r ESC), DEL and C1. A path holding one is never pasted. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/** Characters PowerShell reads literally in a bare argument (no `,` `@` `$` `'` ...). */
const SAFE_POWERSHELL_PATH_RE = /^[A-Za-z0-9_.:\\/-]+$/;

/** PowerShell treats all four of these as a single quote inside '...'. */
const POWERSHELL_SINGLE_QUOTES_RE = /['\u2018\u2019\u201A\u201B]/g;

function quotePowerShellPath(p: string): string {
  if (SAFE_POWERSHELL_PATH_RE.test(p)) return p;
  return `'${p.replace(POWERSHELL_SINGLE_QUOTES_RE, '$&$&')}'`;
}

/**
 * Which quoting a Windows pane gets, from the configured default shell
 * (a path or a legacy name). The renderer does not know each pane's shell,
 * and PowerShell is the app's default, so anything unrecognised is PowerShell.
 */
function windowsQuoteStyle(shell: string | undefined): 'powershell' | 'cmd' | 'posix' {
  const base = (shell ?? '').toLowerCase().split(/[\\/]/).pop() ?? '';
  if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
  if (base.includes('bash') || base.includes('wsl')) return 'posix';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  return 'powershell';
}

/**
 * Quote each path so the pane's shell reads it literally, and join with a
 * single space. POSIX shells and PowerShell get single quotes; cmd.exe cannot
 * read single quotes, so it keeps the double-quote-on-space rule. A path
 * containing a control character is left out (a newline would submit the line
 * outside bracketed paste); if every path is left out the result is ''.
 */
export function quotePathsForPrompt(
  paths: string[],
  platform: string | undefined = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
  windowsShell: string | undefined = platform === 'win32' ? useStore.getState().defaultShell : undefined,
): string {
  const style = platform === 'win32' ? windowsQuoteStyle(windowsShell) : 'posix';
  const quote = style === 'posix'
    ? quotePosixPath
    : style === 'powershell'
      ? quotePowerShellPath
      : (p: string) => (p.includes(' ') ? `"${p}"` : p);
  return paths.filter((p) => p && !CONTROL_CHAR_RE.test(p)).map(quote).join(' ');
}

/** The ordered raw writes for a submit/no-submit inject. Pure, for testing. */
export function buildSubmitWrites(text: string, submit: boolean): string[] {
  return submit ? [text, '\r'] : [text];
}

/** Read the live terminal's bracketed-paste mode for this ptyId. */
function modesFor(ptyId: string): TerminalModesLike | null {
  const terminal = terminalRegistry.get(ptyId);
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
  return modes ?? null;
}

/**
 * Inject text into the pane's PTY through the chunked paste path (bracketed-
 * paste safe, newline-normalized). When `submit` is true, follow with a single
 * CR to send it as one message.
 */
export async function injectText(ptyId: string, text: string, submit: boolean): Promise<void> {
  if (!ptyId || !text) return;
  const write = (d: string) => window.electronAPI.pty.write(ptyId, d);
  await pastePtyChunked(write, text, modesFor(ptyId));
  if (submit) write('\r');
}

/** OS file picker → quoted paths pasted into the pane (no Enter). */
export async function attachFilesToPty(ptyId: string): Promise<void> {
  if (!ptyId) return;
  const paths = await window.electronAPI.dialog.pickFile();
  if (paths.length === 0) return;
  await injectText(ptyId, quotePathsForPrompt(paths), false);
}
