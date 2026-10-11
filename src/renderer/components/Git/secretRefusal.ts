// The plain-language reason a commit / push / PR was refused for carrying a
// secret (shared/secretGuard.ts), in the user's language. Never the value.
import type { SecretFinding } from '../../../shared/secretGuard';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function secretRefusalText(found: readonly SecretFinding[], t: T): string {
  const f = found[0];
  const head = f.what === 'file' ? t('git.secret.file', { path: f.path }) : t('git.secret.value', { path: f.path, line: f.line ?? 1 });
  return found.length > 1 ? `${head} ${t('git.secret.more', { count: found.length - 1 })}` : head;
}
