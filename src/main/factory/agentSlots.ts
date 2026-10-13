// ─── One budget for bots and workers together ──────────────────────────────
//
// Every bot turn runs its own agent process, and every fan-out worker keeps an
// interactive CLI with its MCP servers resident while its task is open. The
// factory caps how many of those run at once (`maxConcurrentAgents`, Settings
// › Bots): in use = bots running a turn + live workers (open fan-out tasks and
// resumed workers) + launches already granted that have not registered yet.
//
// What the cap holds back is a NEW worker a bot starts: the task gets its
// worktree, then waits for a slot before its pane is spawned, first come first
// served (a spawned worker whose ledger row could not be written keeps its
// slot while its workspace lives). While it waits one system card in the bot's thread says so ("waiting
// for a slot") and the Bots page lists it; it starts as soon as a slot frees,
// or is not launched after SLOT_WAIT_MAX_MS. Bot turns themselves are not
// held here (globalConcurrentBots governs them), and work the owner starts
// (a pane's or the window's fan-out, an owner resume) is never held: it runs
// and counts.

export const SLOT_WAIT_MAX_MS = 30 * 60_000;
const POLL_MS = 2_000;

export interface WaitingWorker {
  taskId: string;
  title: string;
  botId: string;
  ownerWorkspaceId: string;
  /** The room thread the bot started it from. */
  threadId?: string;
  since: number;
}

export interface AgentSlotPorts {
  cap: () => number;
  /** Bots running a turn now. */
  runningBots: () => number;
  /** Live workers: open fan-out tasks and resumed workers. */
  liveWorkers: () => number;
  /** Whether a spawned worker whose ledger row was not written still holds
   *  its slot: its workspace lives and still no row counts it. Absent: a held
   *  slot is released at once. */
  stillHeld?: (workspaceId: string) => boolean;
  /** A worker started waiting (a card, a Bots page refresh). */
  onWaiting?: (w: WaitingWorker, inUse: number, cap: number) => void;
  /** The waiting list changed. */
  changed?: () => void;
  now?: () => number;
  maxWaitMs?: number;
  pollMs?: number;
}

export type SlotGrant =
  | { ok: true; release: () => void; hold: (workspaceId: string) => void }
  | { ok: false; reason: string };

interface Waiter {
  w: WaitingWorker;
  resolve: (g: SlotGrant) => void;
  /** Why the launch is no longer wanted (the bot was stopped), or null. */
  refusal?: () => string | null;
}

export class AgentSlots {
  private granted = 0;
  /** Spawned workers with no ledger row, counted until stillHeld says no. */
  private readonly held = new Set<string>();
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly ports: AgentSlotPorts) {}

  /** Agents counted against the cap now. Never throws. */
  inUse(): number {
    for (const ws of [...this.held]) {
      let keep = false;
      try {
        keep = this.ports.stillHeld?.(ws) ?? false;
      } catch {
        keep = true; // cannot tell: keep counting it
      }
      if (!keep) this.held.delete(ws);
    }
    let n = this.granted + this.held.size;
    try {
      n += Math.max(0, this.ports.runningBots()) + Math.max(0, this.ports.liveWorkers());
    } catch {
      /* counted as what could be read */
    }
    return n;
  }

  waiting(): WaitingWorker[] {
    return this.queue.map((q) => ({ ...q.w }));
  }

  /** Wait for a slot for a bot's new worker (FIFO). `refusal` is asked on
   *  every re-check while it waits: a reason ends the wait unlaunched. */
  acquire(w: Omit<WaitingWorker, 'since'>, refusal?: () => string | null): Promise<SlotGrant> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: 'the agent factory stopped' });
    if (this.queue.length === 0 && this.inUse() < this.cap()) return Promise.resolve(this.grant());
    const now = this.ports.now ?? Date.now;
    const waiter: WaitingWorker = { ...w, since: now() };
    return new Promise<SlotGrant>((resolve) => {
      this.queue.push({ w: waiter, resolve, ...(refusal ? { refusal } : {}) });
      try {
        this.ports.onWaiting?.(waiter, this.inUse(), this.cap());
      } catch {
        /* the card is best effort */
      }
      this.ports.changed?.();
      this.arm();
    });
  }

  /** A slot now, or null when none is free (or others wait first): for a
   *  start that does not wait (a bot's resume answers its tool call). */
  tryAcquire(): SlotGrant | null {
    if (this.disposed || this.queue.length > 0 || this.inUse() >= this.cap()) return null;
    return this.grant();
  }

  /** The cap in force (at least 1). */
  limit(): number {
    return this.cap();
  }

  /** Re-check the queue now (a task ended, a turn ended). */
  kick(): void {
    if (this.disposed || this.queue.length === 0) return;
    const now = (this.ports.now ?? Date.now)();
    const maxWait = this.ports.maxWaitMs ?? SLOT_WAIT_MAX_MS;
    let changed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      let why: string | null = null;
      try {
        why = q.refusal?.() ?? null;
      } catch (err) {
        why = `the launch check failed: ${String(err)}`;
      }
      if (!why && now - q.w.since >= maxWait) why = `no agent slot freed within ${Math.round(maxWait / 60_000)} minutes`;
      if (!why) continue;
      this.queue.splice(i, 1);
      q.resolve({ ok: false, reason: why });
      changed = true;
    }
    while (this.queue.length > 0 && this.inUse() < this.cap()) {
      const q = this.queue.shift() as Waiter;
      q.resolve(this.grant());
      changed = true;
    }
    if (changed) this.ports.changed?.();
    if (this.queue.length > 0) this.arm();
  }

  /** Refuse every waiter (factory stopped or disposed). */
  dispose(reason = 'the agent factory stopped'): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, reason });
  }

  private cap(): number {
    try {
      const c = this.ports.cap();
      return Number.isFinite(c) && c >= 1 ? c : 1;
    } catch {
      return 1;
    }
  }

  private grant(): SlotGrant {
    this.granted++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.granted = Math.max(0, this.granted - 1);
      this.kick();
    };
    return {
      ok: true,
      release,
      hold: (workspaceId) => {
        if (released) return;
        if (workspaceId && this.ports.stillHeld) this.held.add(workspaceId);
        release();
      },
    };
  }

  private arm(): void {
    if (this.timer || this.disposed) return;
    const t = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.ports.pollMs ?? POLL_MS);
    t.unref?.();
    this.timer = t;
  }
}

let current: AgentSlots | null = null;

export function setAgentSlots(next: AgentSlots | null): void {
  current = next;
}

export function getAgentSlots(): AgentSlots | null {
  return current;
}
