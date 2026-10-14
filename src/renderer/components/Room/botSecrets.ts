// The owner's side of bot secrets and logins (shared/botSecret.ts), through
// the preload bridge `electronAPI.factory.secrets` (main-window IPC; main
// answers only the main window). A value goes out once, in `set`; nothing
// here ever reads one back.

import type { BotSecretEntry, LoginService } from '../../../shared/botSecret';

export interface SecretRow extends BotSecretEntry {
  /** Decrypted on this computer (false: enter it again to use it). */
  usable: boolean;
}

export type SecretListResult =
  | { ok: true; secrets: SecretRow[]; cannotStore?: { code: string; message: string } }
  | { ok: false; code: string; message: string };

export type SecretSetResult =
  | { ok: true; entry: BotSecretEntry }
  | { ok: false; code: string; message: string };

export type LoginResult =
  | { ok: true; service: LoginService; signedIn: boolean }
  | { ok: false; code: string; message: string };

export interface BotSecretPort {
  readonly available: boolean;
  list(): Promise<SecretListResult>;
  set(req: { name: string; value: string; workspaceId?: string; cardId?: string }): Promise<SecretSetResult>;
  delete(name: string): Promise<{ ok: boolean }>;
  login(req: { workspaceId: string; cardId: string; done?: boolean }): Promise<LoginResult>;
}

interface SecretsBridge {
  list?: () => Promise<SecretListResult>;
  set?: (req: { name: string; value: string; workspaceId?: string; cardId?: string }) => Promise<SecretSetResult>;
  delete?: (name: string) => Promise<{ ok: boolean }>;
  login?: (req: { workspaceId: string; cardId: string; done?: boolean }) => Promise<LoginResult>;
}

const UNAVAILABLE = { ok: false as const, code: 'unavailable', message: 'Keys are not available in this build.' };

function bridgePort(): BotSecretPort {
  const api = (globalThis as { electronAPI?: { factory?: { secrets?: SecretsBridge } } }).electronAPI;
  const b = api?.factory?.secrets;
  return {
    available: !!b?.list && !!b.set,
    list: () => b?.list?.() ?? Promise.resolve(UNAVAILABLE),
    set: (req) => b?.set?.(req) ?? Promise.resolve(UNAVAILABLE),
    delete: (name) => b?.delete?.(name) ?? Promise.resolve({ ok: false }),
    login: (req) => b?.login?.(req) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotSecretPort | null = null;

export function getBotSecretPort(): BotSecretPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotSecretPort(next: BotSecretPort | null): void {
  port = next;
}
