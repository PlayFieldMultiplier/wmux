// ─── Stopping bots from the Bots page ────────────────────────────────────
//
// Two verbs main owns: stop every bot (each running turn interrupted, every
// bot worker stopped, every queued gate cancelled) and stop one bot (its
// turn and its workers). They reach the page through the factory bot port
// when it carries them, else through the preload's `factory` bridge —
//
//   factory: {
//     stopAll(): Promise<StopAllResult>
//     stopBot(botId: string): Promise<StopBotResult>
//   }
//
// Both are optional: a build without them shows no Stop controls.
import { getFactoryBotPort, type FactoryBotPort } from '../Room/factoryPorts';

export interface StopAllResult { ok: boolean; botsInterrupted: number; workersStopped: number; gatesCancelled: number }
export interface StopBotResult { ok: boolean; workersStopped: number }

export interface BotsStopPort {
  stopAll?(): Promise<StopAllResult>;
  stopBot?(botId: string): Promise<StopBotResult>;
}

interface StopBridge {
  stopAll?: () => Promise<StopAllResult>;
  stopBot?: (botId: string) => Promise<StopBotResult>;
}

function bridge(): StopBridge | null {
  const f = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI?.factory;
  return f && typeof f === 'object' ? (f as StopBridge) : null;
}

/** The stop verbs: the port's own when it has them, else the bridge's. */
export function botsStopPort(port?: FactoryBotPort & BotsStopPort): BotsStopPort {
  const p = (port ?? getFactoryBotPort()) as FactoryBotPort & BotsStopPort;
  const b = bridge();
  const stopAll = p.stopAll ? p.stopAll.bind(p) : b?.stopAll;
  const stopBot = p.stopBot ? p.stopBot.bind(p) : b?.stopBot;
  return { ...(stopAll ? { stopAll } : {}), ...(stopBot ? { stopBot } : {}) };
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** What a stop did, in the owner's words: only the counts that are not
 *  zero, or that nothing was running. Pure. */
export function stopAllSummary(r: StopAllResult, t: T): string {
  if (!r.ok) return t('botsPage.stop.failed');
  const parts = [
    r.botsInterrupted > 0 ? t('botsPage.stop.botsInterrupted', { count: r.botsInterrupted }) : '',
    r.workersStopped > 0 ? t('botsPage.stop.workersStopped', { count: r.workersStopped }) : '',
    r.gatesCancelled > 0 ? t('botsPage.stop.gatesCancelled', { count: r.gatesCancelled }) : '',
  ].filter(Boolean);
  return parts.length > 0 ? t('botsPage.stop.done', { what: parts.join(', ') }) : t('botsPage.stop.nothing');
}

/** One bot's stop, in the owner's words. Pure. */
export function stopBotSummary(name: string, r: StopBotResult, t: T): string {
  if (!r.ok) return t('botsPage.stop.failed');
  return r.workersStopped > 0
    ? t('botsPage.stop.botStoppedWorkers', { name, count: r.workersStopped })
    : t('botsPage.stop.botStopped', { name });
}
