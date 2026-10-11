// Runs the shared secret guard (shared/secretGuard.ts) over what a commit,
// push, PR or Moa delivery would send: secret file names first (the only
// signal for a binary file), then key-shaped values in the added lines.
//
// FAIL CLOSED: when git cannot answer (an error, a diff too large to read, a
// bad range), the result is `ok: false` and the caller refuses the action —
// a change nobody could check is never let through.
import { scanUnifiedDiff, secretFileKind, type SecretFinding } from '../../shared/secretGuard';

/** Runs git with these args; the stdout, or null when git failed. */
export type GitText = (args: string[]) => Promise<string | null>;

export type SecretScanResult = { ok: true; findings: SecretFinding[] } | { ok: false };

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-filter=ACMRT'];

/** Secrets added by `git diff <range>` (e.g. ['--cached'] or ['base...head']). */
export async function scanGitRange(git: GitText, range: readonly string[]): Promise<SecretScanResult> {
  try {
    const names = await git([...DIFF, '--name-only', '-z', ...range]);
    if (names === null) return { ok: false };
    const out: SecretFinding[] = [];
    for (const p of names.split('\0').filter(Boolean)) {
      const kind = secretFileKind(p);
      if (kind) out.push({ path: p, what: 'file', kind });
    }
    const diff = await git([...DIFF, '-U0', ...range]);
    if (diff === null) return { ok: false };
    const files = new Set(out.map((f) => f.path));
    for (const f of scanUnifiedDiff(diff)) if (f.what === 'value' || !files.has(f.path)) out.push(f);
    return { ok: true, findings: out.slice(0, 20) };
  } catch {
    return { ok: false };
  }
}
