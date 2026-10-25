import fs from 'node:fs';
import path from 'node:path';

/**
 * Operator display preferences for `wmux web` that outlive the server.
 *
 * Not `web-state.json`: that record is the running server and its token, and
 * an operator stop deletes it to revoke every credential. A preference such as
 * "no inline images" must survive that stop, or a bare re-run after `--stop`
 * would quietly turn images back on. This file holds nothing secret.
 */
export interface WebPrefs {
  /** False when the operator ran `wmux web --no-inline-images` (#1641). */
  inlineImages: boolean;
  /**
   * The port the desktop popover starts on, saved when "Use port N" was
   * pressed because the default one was taken. Absent: WEB_DEFAULT_PORT.
   */
  port?: number;
}

function savedPort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : undefined;
}

const PREFS_FILE = 'web-prefs.json';

export function getWebPrefsPath(wmuxDir: string): string {
  return path.join(wmuxDir, PREFS_FILE);
}

/** The saved preferences; a missing or malformed file reads as the defaults. */
export function loadWebPrefs(wmuxDir: string): WebPrefs {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(getWebPrefsPath(wmuxDir), 'utf8'));
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const port = savedPort(o['port']);
    return { inlineImages: o['inlineImages'] !== false, ...(port ? { port } : {}) };
  } catch {
    return { inlineImages: true };
  }
}

/** Persist the preferences. Best effort: returns false when the write failed. */
export function saveWebPrefs(wmuxDir: string, prefs: WebPrefs): boolean {
  const file = getWebPrefsPath(wmuxDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(wmuxDir, { recursive: true });
    const port = savedPort(prefs.port);
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, inlineImages: prefs.inlineImages, ...(port ? { port } : {}) })}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    return false;
  }
}
