// Runs the secret guard (shared/secretGuard.ts) over what a commit, push, PR,
// adopt or Moa delivery would send. Each check reads the same diff twice: the
// NUL-framed name list (paths, and whether a file is new) and the -U0 patch,
// streamed line by line so a large change is read in full.
//
// A push, PR or delivery is checked commit by commit — each commit's own
// change — so a file added in one commit and removed in a later one is still
// found. A merge commit is checked for what the merge itself changed
// (--diff-merges=remerge; on git before 2.36, its change against each parent).
//
// FAIL CLOSED: when git cannot answer, the result is `ok: false` and the
// caller refuses the action.
import { spawn } from 'node:child_process';
import { getExecEnv } from '../../shared/execEnv';
import { PatchScanner, describeScanFailure, describeSecretFindings, parseNameStatusZ, type SecretFinding } from '../../shared/secretGuard';

/** Runs git with these args, handing each stdout line (split on \n only) to
 *  onLine; true when git exited 0. */
export type GitLines = (args: string[], onLine: (line: string) => void) => Promise<boolean>;

export type SecretScanResult = { ok: true; findings: SecretFinding[] } | { ok: false };

const SCAN_TIMEOUT_MS = 5 * 60_000;

/** A GitLines that spawns git in `cwd` and streams its output (no size cap). */
export function spawnGitLines(cwd: string, env: NodeJS.ProcessEnv = {}): GitLines {
  return (args, onLine) => spawnLines('git', args, { cwd, env: { ...getExecEnv(), ...env } }, onLine);
}

/**
 * Runs `file` with `args` and exactly `env`, handing each stdout line to
 * onLine as spawnGitLines does (no size cap, killed after SCAN_TIMEOUT_MS);
 * true when it exited 0.
 */
export function spawnLines(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, onLine: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
    let pending: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      let start = 0;
      for (let i = chunk.indexOf('\n'); i !== -1; i = chunk.indexOf('\n', start)) {
        pending.push(chunk.slice(start, i));
        onLine(pending.join(''));
        pending = [];
        start = i + 1;
      }
      pending.push(chunk.slice(start));
    });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = pending.join('');
      if (last) onLine(last);
      resolve(code === 0);
    });
  });
}

/** Same diff for both reads: new / modified / type-changed files, renames as
 *  delete + add (so a renamed-to name is judged as new), no external diff or
 *  textconv, plain submodule lines. */
const DIFF = ['--no-renames', '--diff-filter=AMT', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short'];
const NAMES = ['-z', '--name-status'];
/** --text: every file's added lines are read, whatever .gitattributes says. */
const PATCH = ['-p', '-U0', '--text'];

async function scan(run: GitLines, names: string[], patch: string[]): Promise<SecretScanResult> {
  const scanner = new PatchScanner(parseNameStatusZ(names.join('\n')));
  if (!await run(patch, (l) => scanner.feed(l))) return { ok: false };
  const findings = scanner.finish();
  return findings ? { ok: true, findings } : { ok: false };
}

/** Secrets added by `git diff <args>` (['--cached'], or [base] for a worktree). */
export async function scanDiff(run: GitLines, args: string[]): Promise<SecretScanResult> {
  const names: string[] = [];
  if (!await run(['diff', ...NAMES, ...DIFF, ...args], (l) => names.push(l))) return { ok: false };
  return scan(run, names, ['diff', ...PATCH, ...DIFF, ...args]);
}

/** Secrets added by any commit in `revs` (rev-list arguments), each commit's own change. */
export async function scanCommits(run: GitLines, revs: string[]): Promise<SecretScanResult> {
  const log = (merges: string[], out: string[]) => ['log', '--root', '--no-show-signature', '--format=%x01%H', ...merges, ...out, ...DIFF, ...revs, '--'];
  for (const merges of [['--diff-merges=remerge'], ['-m']]) {
    const names: string[] = [];
    // remerge needs git 2.36: on a failure, read merges against each parent.
    if (await run(log(merges, NAMES), (l) => names.push(l))) return scan(run, names, log(merges, PATCH));
  }
  return { ok: false };
}

/** Why a scan stops the action, as the Git page words it; null to go ahead.
 *  `action` completes "so it was not …" ('pushed', 'sent in a pull request'). */
export type SecretRefusal = { error: string; secrets: SecretFinding[] } | { error: string; secretScanFailed: true };

export function secretRefusal(scan: SecretScanResult, action: string): SecretRefusal | null {
  if (!scan.ok) return { error: describeScanFailure(action), secretScanFailed: true };
  if (scan.findings.length) return { error: describeSecretFindings(scan.findings, action), secrets: scan.findings };
  return null;
}

/** rev-list arguments for the commits a PR from `head` shows against `base`
 *  (a remote-tracking ref): those not on it when it exists, else those on no
 *  remote-tracking ref at all. */
export async function reviewRange(run: GitLines, head: string, base: string | null): Promise<string[]> {
  if (base && await run(['rev-parse', '--verify', '-q', `${base}^{commit}`], () => undefined)) return [head, '--not', base];
  return [head, '--not', '--remotes'];
}
