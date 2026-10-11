// Runs the shared secret guard (shared/secretGuard.ts) over what a commit,
// push, PR or adopt would send: secret file names first (cheap, and the only
// signal for a binary file), then key-shaped values in the added lines.
import { scanUnifiedDiff, secretFileKind, type SecretFinding } from '../../shared/secretGuard';

/** Runs git with these args; the stdout, or null when git failed. */
export type GitText = (args: string[]) => Promise<string | null>;

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-filter=ACMRT'];

/**
 * Secrets added by `git diff <range>` (e.g. ['--cached'] or ['base...head']).
 * A diff too large to read still has its file names checked.
 */
export async function scanGitRange(git: GitText, range: readonly string[]): Promise<SecretFinding[]> {
  const out: SecretFinding[] = [];
  const names = await git([...DIFF, '--name-only', '-z', ...range]);
  for (const p of (names ?? '').split('\0').filter(Boolean)) {
    const kind = secretFileKind(p);
    if (kind) out.push({ path: p, what: 'file', kind });
  }
  const diff = await git([...DIFF, '-U0', ...range]);
  if (diff) {
    const files = new Set(out.map((f) => f.path));
    for (const f of scanUnifiedDiff(diff)) if (f.what === 'value' || !files.has(f.path)) out.push(f);
  }
  return out.slice(0, 20);
}
