/**
 * The live "Preparing" card of a worktree a person opened: what its new
 * workspace preparation is doing (files copied, setup running for how long),
 * and, when the setup fails, the decision that card asks for:
 *   - retry: run the setup again in the same worktree;
 *   - start: start the agent anyway (paths that start one);
 *   - dismiss: leave the worktree as it is and start nothing.
 *
 * Main owns the cards; the renderer only draws them (WORKSPACE_PREP_EVENT)
 * and answers (WORKSPACE_PREP_DECIDE). Cards carry counts and the setup's last
 * output lines, never a copied file's name or content.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { getWmuxHomeDir } from '../../shared/constants';
import { isDefaultCopyCandidate } from '../../shared/workspacePrepSettings';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import { listCopyCandidates } from '../project/workspacePrepSettings';
import type { WorkspacePrepProgress, WorkspacePrepResult } from './workspacePrep';
import type { WorkspacePrepCard, WorkspacePrepDecision } from '../../shared/workspacePrepCard';

export type { WorkspacePrepCard, WorkspacePrepDecision };

/** How long a failed card waits for an answer before it counts as dismissed. */
export const WORKSPACE_PREP_DECISION_TTL_MS = 30 * 60 * 1000;

export interface PrepCardHandle {
  readonly id: string;
  progress(p: WorkspacePrepProgress): void;
  /** A finished run: 'ready' / 'skipped' close the card's wait; 'failed' shows the failure. */
  result(r: WorkspacePrepResult): void;
  /** Wait for the person's answer to a failure. */
  decision(): Promise<WorkspacePrepDecision>;
  /** The card is done (the agent started, or the worktree was left alone). */
  close(): void;
}

type Sink = (card: WorkspacePrepCard) => void;

export class WorkspacePrepCards {
  private readonly cards = new Map<string, WorkspacePrepCard>();
  private readonly waiting = new Map<string, (d: WorkspacePrepDecision) => void>();
  private sink: Sink = () => undefined;

  constructor(private readonly opts: { now?: () => number; decisionTtlMs?: number } = {}) {}

  setSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Every open card (a renderer that reloads draws them again). */
  list(): WorkspacePrepCard[] {
    return [...this.cards.values()];
  }

  begin(title: string, startsAgent: boolean, extra: { suggestCopy?: WorkspacePrepCard['suggestCopy'] } = {}): PrepCardHandle {
    const id = randomUUID();
    const now = this.opts.now ?? Date.now;
    let card: WorkspacePrepCard = {
      id, title, startsAgent, status: 'running', phase: 'copying', copied: 0, missing: 0, refused: 0, updatedAt: now(),
      ...(extra.suggestCopy ? { suggestCopy: extra.suggestCopy } : {}),
    };
    const publish = (next: Partial<WorkspacePrepCard>): void => {
      card = { ...card, ...next, updatedAt: now() };
      this.cards.set(id, card);
      try { this.sink(card); } catch { /* a closed window never fails the preparation */ }
    };
    publish({});
    return {
      id,
      progress: (p) => publish({
        status: 'running',
        phase: p.phase,
        copied: p.copy.copied,
        missing: p.copy.missing,
        refused: p.copy.refused,
        ...(p.setupStartedAt !== undefined ? { setupStartedAt: p.setupStartedAt } : {}),
        ...(p.setupTimeoutMs !== undefined ? { setupTimeoutMs: p.setupTimeoutMs } : {}),
        error: undefined,
        outputTail: undefined,
        timedOut: undefined,
      }),
      result: (r) => publish({
        status: r.status === 'failed' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'ready',
        // In place: a retry finds the files the first run copied already there.
        copied: r.copy.copied + r.copy.present,
        missing: r.copy.missing,
        refused: r.copy.refused,
        ...(r.copyBlocked ? { copyBlocked: true } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        error: r.error,
        outputTail: r.outputTail,
        timedOut: r.timedOut,
      }),
      decision: () => new Promise<WorkspacePrepDecision>((resolve) => {
        const timer = setTimeout(() => settle('dismiss'), this.opts.decisionTtlMs ?? WORKSPACE_PREP_DECISION_TTL_MS);
        timer.unref?.();
        const settle = (d: WorkspacePrepDecision): void => {
          clearTimeout(timer);
          this.waiting.delete(id);
          resolve(d);
        };
        this.waiting.set(id, settle);
      }),
      close: () => {
        this.waiting.get(id)?.('dismiss');
        this.cards.delete(id);
        try { this.sink({ ...card, status: 'closed', updatedAt: now() }); } catch { /* best-effort */ }
      },
    };
  }

  /** The person's answer from the card. False when the card is not waiting. */
  decide(id: string, decision: WorkspacePrepDecision): boolean {
    const card = this.cards.get(id);
    const settle = this.waiting.get(id);
    if (!card || !settle || card.status !== 'failed') return false;
    if (decision === 'start' && !card.startsAgent) return false;
    settle(decision);
    return true;
  }
}

let shared: WorkspacePrepCards | null = null;

export function getWorkspacePrepCards(): WorkspacePrepCards {
  return (shared ??= new WorkspacePrepCards());
}

/**
 * Run a preparation under a card, asking the person when it fails, until it
 * succeeds or they answer start/dismiss. `run` is called again on retry.
 * Returns what to do next: 'start' (launch the agent, also after a successful
 * run) or 'dismiss' (start nothing; the worktree stays).
 */
export async function runWithPrepCard(
  handle: PrepCardHandle,
  run: (onProgress: (p: WorkspacePrepProgress) => void) => Promise<WorkspacePrepResult>,
): Promise<{ next: 'start' | 'dismiss'; last: WorkspacePrepResult }> {
  for (;;) {
    const r = await run((p) => handle.progress(p));
    handle.result(r);
    if (r.status !== 'failed') {
      handle.close();
      return { next: 'start', last: r };
    }
    const d = await handle.decision();
    if (d === 'retry') continue;
    handle.close();
    return { next: d === 'start' ? 'start' : 'dismiss', last: r };
  }
}

// ── The one-time "Copy this file too?" suggestion ────────────────────────────

/** Projects the suggestion was made for, so it is made once per project. */
const SUGGESTED_FILE = 'workspace-prep-suggested.json';
const MAX_SUGGESTED = 512;

export interface CopySuggestionStore {
  has(root: string): boolean;
  add(root: string): void;
}

export function fileCopySuggestionStore(file: string = path.join(getWmuxHomeDir(), SUGGESTED_FILE)): CopySuggestionStore {
  const read = (): string[] => {
    try {
      const v = atomicReadJSONSync<{ roots?: unknown }>(file);
      return Array.isArray(v?.roots) ? v.roots.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: (root) => read().includes(root),
    add: (root) => {
      const roots = read();
      if (roots.includes(root)) return;
      try {
        atomicWriteJSONSync(file, { roots: [...roots, root].slice(-MAX_SUGGESTED) });
      } catch {
        // best-effort: at worst the suggestion is made once more
      }
    },
  };
}

/**
 * The suggestion for a worktree a person opened, made once per project: when
 * the project copies no config files yet (`fanout.copy` never set) and its
 * checkout has `.env` files a worktree does not get. Marks the project as
 * suggested. Undefined otherwise.
 */
export async function takeCopySuggestion(
  state: ProjectConfigState,
  sourceCwd: string,
  store: CopySuggestionStore,
  listCandidates: (root: string) => Promise<string[]> = listCopyCandidates,
): Promise<{ cwd: string; count: number } | undefined> {
  if (state.config?.fanout?.copy !== undefined || state.config?.fanout?.invalidFields?.includes('copy')) return undefined;
  const root = state.found && state.configPath ? path.dirname(state.configPath) : sourceCwd;
  const key = path.resolve(root);
  if (store.has(key)) return undefined;
  const count = (await listCandidates(root).catch(() => [])).filter(isDefaultCopyCandidate).length;
  if (count === 0) return undefined;
  store.add(key);
  return { cwd: sourceCwd, count };
}
