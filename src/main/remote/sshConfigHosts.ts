// The "Add PC over SSH" picker's host list: concrete `Host` names from the
// user's ~/.ssh/config (and the files it Includes). Patterns (`*`, `?`),
// negations (`!`) and `Match` blocks name no single computer, so they are
// skipped; anything a person could still type goes in the free-form field.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isValidSshAlias } from './sshCommand';

const MAX_FILES = 32;
const MAX_HOSTS = 200;

function expandInclude(pattern: string, sshDir: string): string[] {
  const p = pattern.startsWith('~/') ? path.join(os.homedir(), pattern.slice(2)) : pattern;
  const abs = path.isAbsolute(p) ? p : path.join(sshDir, p);
  const base = path.basename(abs);
  if (!/[*?]/.test(base)) return [abs];
  // A glob in the last segment only — the common `Include config.d/*` shape.
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return fs.readdirSync(path.dirname(abs)).filter((n) => re.test(n)).sort().map((n) => path.join(path.dirname(abs), n));
  } catch {
    return [];
  }
}

/** Concrete Host aliases, in file order, de-duplicated. Never throws. */
export function listSshConfigHosts(configPath = path.join(os.homedir(), '.ssh', 'config')): string[] {
  const sshDir = path.dirname(configPath);
  const out: string[] = [];
  const seenFiles = new Set<string>();
  const visit = (file: string): void => {
    if (seenFiles.has(file) || seenFiles.size >= MAX_FILES) return;
    seenFiles.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([^\s=]+)\s*=?\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2];
      if (key === 'include') {
        for (const pat of value.split(/\s+/).filter(Boolean)) for (const f of expandInclude(pat, sshDir)) visit(f);
      } else if (key === 'host') {
        for (const name of value.split(/\s+/)) {
          const alias = name.replace(/^"|"$/g, '');
          if (!alias || /[*?!]/.test(alias) || !isValidSshAlias(alias)) continue;
          if (!out.includes(alias) && out.length < MAX_HOSTS) out.push(alias);
        }
      }
    }
  };
  visit(configPath);
  return out;
}
