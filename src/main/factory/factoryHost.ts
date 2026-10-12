// ─── Factory host — the one seam between main and the agent factory ────────
//
// main/index.ts calls `registerFactoryRpc(router, deps)` once, `start()` once
// the app is ready, and `dispose()` on quit. Everything the factory adds to
// main attaches here through a module registered from its own file
// (`registerFactoryRpcModule`), imported once by ./modules.ts — so no later
// change edits index.ts or the RPC registries.
//
// Fail closed: every factory RPC method (shared/botSurface.ts
// FACTORY_RPC_METHODS) is registered first with a handler that answers a
// typed `not_implemented` refusal; a module's own `router.register` for the
// same method replaces it. A module that throws while registering is logged
// and skipped — its methods keep answering `not_implemented`.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../pipe/RpcRouter';
import type { DaemonClient } from '../DaemonClient';
import type { FanOutService } from '../worktask/FanOutService';
import { FACTORY_RPC_METHODS, factoryNotImplemented } from '../../shared/botSurface';
import { runFactoryMigrations } from './migrate';

/** What main hands every factory module. Over-provided on purpose: index.ts
 *  is not edited again, so a module takes what it needs from here or imports
 *  a singleton itself. */
export interface FactoryHostDeps {
  getMainWindow: () => BrowserWindow | null;
  getDaemonClient: () => DaemonClient | null;
  /** The one FanOutService instance (shared with the renderer and pipe lanes). */
  fanOutService: FanOutService;
  /** Dispatch as the renderer operator (no clientName, operator lane). */
  invokeRendererRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** A pane's owning workspace, or null. */
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>;
  /** A pane's own cwd ('' when unknown). */
  paneCwd: (ptyId: string, workspaceId: string) => string;
  /** The wmux data dir (`getWmuxDir()`), `factory/` lives under it. */
  wmuxDir: () => string;
}

/** What a module's register function may return. */
export interface FactoryModuleHandle {
  /** Called once the app is ready (after the pipe server started). */
  start?: () => void | Promise<void>;
  /** Called on quit, in reverse registration order. */
  dispose?: () => void | Promise<void>;
}

export type FactoryRpcModule = (router: RpcRouter, deps: FactoryHostDeps) => void | FactoryModuleHandle;

interface ModuleEntry { name: string; register: FactoryRpcModule; }

const modules: ModuleEntry[] = [];

/** Add a factory module (call at import time from the module's own file).
 *  Throws on a duplicate name. */
export function registerFactoryRpcModule(name: string, register: FactoryRpcModule): void {
  if (modules.some((m) => m.name === name)) throw new Error(`factory module ${name} is registered twice`);
  modules.push({ name, register });
}

export function registeredFactoryModules(): readonly string[] {
  return modules.map((m) => m.name);
}

/** Test-only. */
export function __resetFactoryModulesForTesting(): void {
  modules.length = 0;
}

export interface FactoryHost {
  /** Modules whose register function completed. */
  readonly modules: readonly string[];
  start(): Promise<void>;
  dispose(): Promise<void>;
}

function logError(what: string, err: unknown): void {
  console.error(`[factory] ${what}:`, err);
}

/** Register every factory RPC method (fail-closed stubs first, then the
 *  modules). Call once. */
export function registerFactoryRpc(router: RpcRouter, deps: FactoryHostDeps): FactoryHost {
  for (const method of FACTORY_RPC_METHODS) {
    router.register(method, async () => factoryNotImplemented(method));
  }
  const loaded: { name: string; handle: FactoryModuleHandle }[] = [];
  for (const entry of modules) {
    try {
      const handle = entry.register(router, deps) ?? {};
      loaded.push({ name: entry.name, handle });
    } catch (err) {
      logError(`module ${entry.name} failed to register`, err);
    }
  }
  let started = false;
  let disposed = false;
  return {
    modules: loaded.map((l) => l.name),
    async start() {
      if (started || disposed) return;
      started = true;
      try {
        runFactoryMigrations(deps.wmuxDir());
      } catch (err) {
        logError('migration failed', err);
      }
      for (const { name, handle } of loaded) {
        try {
          await handle.start?.();
        } catch (err) {
          logError(`module ${name} failed to start`, err);
        }
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const { name, handle } of [...loaded].reverse()) {
        try {
          await handle.dispose?.();
        } catch (err) {
          logError(`module ${name} failed to dispose`, err);
        }
      }
    },
  };
}
