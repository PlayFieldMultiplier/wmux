// The renderer's RPC bridge (`rpc:invoke`): the main window asks main to
// dispatch one pipe RPC as the operator. It answers only the main window's
// top frame (mainWindowSender.ts); any other sender gets a refusal and
// nothing is dispatched.

import type { BrowserWindow } from 'electron';
import { isMainWindowSender } from './mainWindowSender';

export type RendererRpcInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export const RPC_INVOKE_NOT_MAIN_WINDOW = { ok: false, error: 'rpc:invoke: only the main window may call it' } as const;

export function createRpcInvokeHandler(
  getWindow: () => BrowserWindow | null,
  invoke: () => RendererRpcInvoke | undefined,
): (event: { sender?: unknown; senderFrame?: unknown }, method: unknown, params: unknown) => Promise<unknown> {
  return async (event, method, params) => {
    if (!isMainWindowSender(event, getWindow())) return RPC_INVOKE_NOT_MAIN_WINDOW;
    if (typeof method !== 'string' || method.length === 0) {
      return { ok: false, error: 'rpc:invoke: missing method' };
    }
    // An object-typed params is required (the router validates this too).
    const safeParams =
      params !== undefined && params !== null && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};
    const run = invoke();
    if (!run) return { ok: false, error: 'rpc:invoke: renderer RPC bridge not wired' };
    return run(method, safeParams);
  };
}
