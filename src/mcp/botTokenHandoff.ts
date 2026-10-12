// ─── Bot token hand-off — the MCP entry side ───────────────────────────────
//
// In bot mode (`--bot=<role>`) the token comes from the file named by
// `--bot-token-file=<path>` (main/factory/botTokenHandoff.ts writes it for one
// spawn), never from the environment. The file is read once and deleted.
// Anything off — no flag, an unreadable or oversized file, a file other users
// can read, an empty token — yields '' and the server claims the bot role
// with an empty token, which main refuses on every call (fail closed).

import fs from 'node:fs';
import { botTokenFileArgValue } from '../shared/bot';

/** Longer than any token main mints (two UUIDs). */
const MAX_TOKEN_FILE_BYTES = 256;

export interface TokenFileIo {
  lstat(path: string): { isFile(): boolean; size: number; mode: number };
  readFile(path: string): string;
  unlink(path: string): void;
  platform: NodeJS.Platform;
}

const NODE_IO: TokenFileIo = {
  lstat: (p) => fs.lstatSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  unlink: (p) => fs.unlinkSync(p),
  platform: process.platform,
};

/** Read and consume the bot token named in `argv`, or '' (see above). */
export function readBotTokenFromArgv(argv: readonly string[], io: TokenFileIo = NODE_IO): string {
  const file = botTokenFileArgValue(argv);
  if (!file) return '';
  let token = '';
  try {
    const st = io.lstat(file);
    const privateToOwner = io.platform === 'win32' || (st.mode & 0o077) === 0;
    if (st.isFile() && st.size > 0 && st.size <= MAX_TOKEN_FILE_BYTES && privateToOwner) {
      token = io.readFile(file).trim();
    }
  } catch {
    token = '';
  }
  try {
    io.unlink(file);
  } catch {
    /* already gone */
  }
  return /^[A-Za-z0-9-]+$/.test(token) ? token : '';
}
