// ─── Hermes install — the version of the install `hermes` runs, read from files ─
//
// Hermes's `--version` runs its update check (hermes_cli/main.py cmd_version →
// _print_version_info(check_updates=True) → banner.py check_for_updates),
// which runs `git fetch` in the install the command resolves to and writes
// `.update_check` in HERMES_HOME. Hermes has no switch that turns that check
// off for `--version`, so wmux never runs it: the version is read from the
// install's `hermes_cli/__init__.py` (`__version__ = "X.Y.Z"`), the module
// Hermes itself reports.
//
// The install is found from the executable `hermes` resolves to:
// - the executable itself, or, for a small shell launcher (the installer's
//   `exec "<install>/venv/bin/hermes" "$@"`), each absolute `…/hermes` path
//   it names;
// - followed through symlinks to `<venv>/bin/hermes` (`<venv>\Scripts\…` on
//   Windows);
// - then `<venv>/../hermes_cli/__init__.py` (a source checkout installed
//   into its own venv, as the installer does), else the venv's
//   `site-packages/hermes_cli/__init__.py` (a pip, pipx or uv install).
// Nothing is run and nothing is written.

import fs from 'node:fs';
import path from 'node:path';

/** At most this much of a launcher or version module is read. */
const LAUNCHER_MAX_BYTES = 8 * 1024;
const VERSION_MAX_BYTES = 256 * 1024;

/** `X.Y.Z` (or `X.Y.Z-<pre>`) from an install's `hermes_cli/__init__.py`
 *  text (`__version__ = "0.22.5"`), or null. Pure. */
export function parseInstallVersion(text: string): string | null {
  const m = /^__version__\s*=\s*["'](\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,40}))?["']\s*$/m.exec(text);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] ? `-${m[4]}` : ''}` : null;
}

export interface HermesInstallDeps {
  realpath?: (p: string) => string;
  /** A file's text when it is a regular file of at most `max` bytes, else null. */
  readText?: (file: string, max: number) => string | null;
  readdir?: (dir: string) => string[];
}

function readText(file: string, max: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The version modules that may belong to the install `exe` runs, most
 *  likely first. Reads only small files and directory names. */
export function hermesVersionFiles(exe: string, deps: HermesInstallDeps = {}): string[] {
  const real = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const read = deps.readText ?? readText;
  const readdir = deps.readdir ?? ((d: string) => fs.readdirSync(d));
  const targets = [exe];
  const launcher = read(exe, LAUNCHER_MAX_BYTES);
  if (launcher !== null && launcher.startsWith('#!')) {
    for (const m of launcher.matchAll(/(["']?)(\/[^"'\s]+\/hermes)\1/g)) targets.push(m[2]);
  }
  const out: string[] = [];
  for (const t of targets) {
    let r = t;
    try {
      r = real(t);
    } catch {
      continue;
    }
    const bin = path.dirname(r);
    if (!/^(bin|scripts)$/i.test(path.basename(bin))) continue;
    const venv = path.dirname(bin);
    out.push(path.join(path.dirname(venv), 'hermes_cli', '__init__.py'));
    for (const lib of ['lib', 'Lib']) {
      const libDir = path.join(venv, lib);
      let names: string[] = [];
      try {
        names = readdir(libDir);
      } catch {
        continue;
      }
      if (names.includes('site-packages')) out.push(path.join(libDir, 'site-packages', 'hermes_cli', '__init__.py'));
      for (const py of names.filter((n) => /^python3(\.\d+)?$/.test(n))) out.push(path.join(libDir, py, 'site-packages', 'hermes_cli', '__init__.py'));
    }
  }
  return [...new Set(out)];
}

/** The version of the install `exe` runs, read from its files, or null when
 *  no version module is found or none parses. Never runs anything. */
export function hermesInstallVersion(exe: string, deps: HermesInstallDeps = {}): string | null {
  const read = deps.readText ?? readText;
  for (const file of hermesVersionFiles(exe, deps)) {
    const text = read(file, VERSION_MAX_BYTES);
    const v = text === null ? null : parseInstallVersion(text);
    if (v) return v;
  }
  return null;
}
