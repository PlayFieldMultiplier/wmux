import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptPathCheck } from '../hooks/transcriptPathGuard';
import type { ScanReport } from './TranscriptDiscovery';

/**
 * Where Qwen Code keeps a conversation, for exact resume only (wmux reads no
 * Qwen transcript: there is no parser, and no chat feature uses it).
 *
 * From the official source (QwenLM/qwen-code, packages/core: config/storage.ts
 * and services/chatRecordingService.ts, checked 2026-10-23): the file is
 * `<base>/projects/<sanitized cwd>/chats/<sessionId>.jsonl`, where `<base>` is
 * `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen`.
 */

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The Claude scan's bounds (TranscriptDiscovery.ts), kept here: that module imports providers.ts, which imports this one. */
const MAX_PROJECT_DIRS = 512;
const MAX_CANDIDATES = 8;

/**
 * `<base>/projects` for the account a launch with `env` uses: read from that
 * one env (the daemon's own when none is given), never mixed with the other,
 * so a pane's QWEN_HOME is not overridden by the daemon's runtime dir.
 */
export function qwenProjectsRoot(env?: Record<string, string | undefined>): string {
  const from = env ?? process.env;
  const base = from.QWEN_RUNTIME_DIR || from.QWEN_HOME || path.join(from.HOME || os.homedir(), '.qwen');
  return path.join(path.resolve(base), 'projects');
}

const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** `<projects>/*\/chats/<id>.jsonl` files that exist, one project level deep and bounded like the Claude scan. */
export function findQwenTranscriptCandidates(id: string, env?: Record<string, string>, report?: ScanReport): string[] {
  if (report) report.complete = true;
  const incomplete = (): void => { if (report) report.complete = false; };
  if (!UUID_RE.test(id)) return [];
  const root = qwenProjectsRoot(env);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (!isMissing(err)) incomplete();
    return [];
  }
  const found: string[] = [];
  let examined = 0;
  for (const entry of entries) {
    if (examined >= MAX_PROJECT_DIRS) { incomplete(); break; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    examined += 1;
    const candidate = path.join(root, entry.name, 'chats', `${id}.jsonl`);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch (err) {
      if (!isMissing(err)) incomplete();
      continue;
    }
    found.push(candidate);
    if (found.length >= MAX_CANDIDATES) { incomplete(); return found; }
  }
  return found;
}

/**
 * `file` is session `id`'s conversation in this account: a regular file
 * named `<id>.jsonl` in a `chats` folder of a project under the account's
 * `projects`, through real paths.
 */
export function checkQwenTranscriptPath(file: string, id: string, env?: Record<string, string>): TranscriptPathCheck {
  if (!path.isAbsolute(file) || file.includes('\0') || !UUID_RE.test(id)) return { ok: false, reason: 'invalid-identity' };
  let root: string;
  try {
    root = fs.realpathSync(qwenProjectsRoot(env));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const resolved = fs.realpathSync(file);
    const chats = path.dirname(resolved);
    if (path.basename(resolved) !== `${id}.jsonl` || path.basename(chats) !== 'chats' || path.dirname(path.dirname(chats)) !== root ||
        !fs.lstatSync(resolved).isFile()) return { ok: false, reason: 'outside-account-session' };
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? 'missing' : 'unreadable' };
  }
}
