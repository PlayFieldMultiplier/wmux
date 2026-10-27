/**
 * The folder-guarded resume line, shared by the daemon (chat handoff, account
 * switch, bound resume) and the renderer (the lost-folder resume notice). Pure
 * and Node-free so the renderer can import it.
 */

/** The shells a resume command is written for: POSIX sh-family, or PowerShell (5.1 and 7). */
export type ResumeShell = 'posix' | 'pwsh';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single quotes: also closed by the typographic single quotes, so those are doubled too. */
export function pwshQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** `line`, run only once the shell has changed to `cwd`. */
export function inResumeCwd(cwd: string, line: string, shell: ResumeShell): string {
  // PowerShell 5.1 has no `&&`; `Set-Location -PassThru` yields nothing when it fails.
  return shell === 'pwsh'
    ? `if (Set-Location -LiteralPath ${pwshQuote(cwd)} -PassThru -ErrorAction SilentlyContinue) { ${line} }`
    : `cd -- ${shellQuote(cwd)} && ${line}`;
}

/** The cwd forms each shell's resume line takes: a POSIX absolute path, or a Windows one. */
// eslint-disable-next-line no-control-regex -- refusing controls is the point
const CONTROL = /[\0-\x1f\x7f]/;
export function resumeCwdUsable(cwd: string, shell: ResumeShell): boolean {
  if (!cwd || CONTROL.test(cwd)) return false;
  return shell === 'pwsh' ? /^[A-Za-z]:[\\/]/.test(cwd)
    : cwd.startsWith('/') && !/['\\‘-‛]/.test(cwd);
}
