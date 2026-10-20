// Durable finite plans over the existing task ledger and fan-out executor.
// Every dispatch intent is awaited on disk before calling fan-out. An intent
// with no task evidence after restart is blocked, never blindly replayed.
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from '../deck/serialChain';
import { WORKFLOW_BLOCK, WORKFLOW_LIMITS, workflowTaskBlocked, type BotWorkflow, type WorkflowCreateParams, type WorkflowResultBinding } from '../../shared/botWorkflow';
import type { LedgerEntry } from '../../shared/ledger';
import { isSystemGatePass } from '../../shared/botTask';
import { parseThreadId } from '../../shared/room';
import { redactStoredSecretsDeep } from './secretRedaction';
import { workflowPromptFits } from './workflowPrompt';

export const botWorkflowsPath = (dir: string): string => path.join(dir, 'factory', 'workflows.json');
const copy = <T>(value: T): T => structuredClone(value);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validateWorkflowInput(v: unknown): v is WorkflowCreateParams {
  return object(v) && bounded(v.clientWorkflowId, WORKFLOW_LIMITS.clientIdChars)
    && bounded(v.title, WORKFLOW_LIMITS.titleChars) && Array.isArray(v.steps)
    && v.steps.length > 0 && v.steps.length <= WORKFLOW_LIMITS.steps
    && v.steps.every((step) => object(step) && bounded(step.title, WORKFLOW_LIMITS.titleChars) && bounded(step.prompt, WORKFLOW_LIMITS.promptChars) && workflowPromptFits(step.prompt));
}

function validSteps(w: Record<string, unknown>): boolean {
  const steps = w.steps as Record<string, unknown>[];
  let unfinished = false;
  for (const s of steps) {
    if (!['pending', 'dispatching', 'waiting', 'completed', 'blocked'].includes(String(s.state))) return false;
    if (unfinished && s.state !== 'pending') return false;
    if (s.state !== 'completed') unfinished = true;
    if (s.state === 'pending') {
      if (s.dispatchKey !== undefined || s.taskId !== undefined || s.result !== undefined) return false;
    } else if (!bounded(s.dispatchKey, 200)
      && !(s.state === 'blocked' && w.stoppedByOwner === true && s.dispatchKey === undefined && s.taskId === undefined)) return false;
    if ((s.state === 'waiting' || s.state === 'completed') && !bounded(s.taskId, 200)) return false;
    if (s.state === 'completed') {
      const r = s.result;
      if (!object(r) || r.taskId !== s.taskId || !Number.isSafeInteger(r.rev) || Number(r.rev) < 1
        || typeof r.summary !== 'string' || r.summary.length > 4_000
        || !((typeof r.headSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.headSha))
          !== (Number.isSafeInteger(r.mergedPr) && Number(r.mergedPr) > 0))
        || (r.at !== undefined && !Number.isFinite(r.at))) return false;
    } else if (s.result !== undefined) return false;
  }
  if (w.stoppedByOwner !== undefined && (w.stoppedByOwner !== true || w.state !== 'blocked')) return false;
  return w.state === 'completed' ? !unfinished
    : w.state === 'blocked' ? steps.some((s) => s.state === 'blocked')
    : unfinished && !steps.some((s) => s.state === 'blocked');
}

/** No report, skip, forced completion, or stale failed gate unlocks a step. */
export function workflowTaskResult(row: LedgerEntry): WorkflowResultBinding | null {
  if (row.status !== 'completed' || row.updatedBy.kind !== 'brain') return null;
  if (row.completion?.source === 'merge') {
    return { taskId: row.id, rev: row.rev, mergedPr: row.completion.pr, summary: (row.summary ?? '').slice(0, 4_000), at: row.updatedAt };
  }
  if (row.completion?.source !== 'gate' || !isSystemGatePass(row.gate)
    || !row.gate?.headSha || row.completion.headSha !== row.gate.headSha
    || row.completion.reportRev !== row.reportedAtRev || row.gate.reportRev !== row.reportedAtRev) return null;
  return { taskId: row.id, rev: row.rev, headSha: row.gate.headSha, summary: (row.summary ?? '').slice(0, 4_000), at: row.updatedAt };
}

const changeListeners = new Set<() => void>();
/** Told after any store persists a change; returns the unsubscribe. */
export function onBotWorkflowsChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

export class BotWorkflowStore {
  private records: BotWorkflow[] = [];
  private readonly serial = createSerialChain();
  constructor(private readonly file: string, private readonly now = Date.now,
    private readonly write: (file: string, value: unknown) => Promise<void> = (file, value) => atomicWriteJSON(file, value, { durable: true })) {}

  load(): void {
    // Older backups may predate a dispatched side effect. Never roll back
    // an intent to pending: an unreadable/missing primary with history stops
    // this module until the owner inspects the evidence.
    if (!fs.existsSync(this.file)) {
      const dir = path.dirname(this.file);
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.startsWith(`${path.basename(this.file)}.`))) throw new Error('workflow primary is missing; backup recovery requires inspection');
      return;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!object(raw) || raw.version !== 1) throw new Error('unsupported workflow file');
    // Malformed dispatch evidence must never turn back into pending work.
    if (!Array.isArray(raw.workflows) || raw.workflows.length > WORKFLOW_LIMITS.totalRecords
      || !raw.workflows.every((w) => object(w) && validateWorkflowInput(w)
        && typeof w.id === 'string' && /^wf-[a-f0-9]{24}$/.test(w.id)
        && bounded(w.botId, 100) && bounded(w.workspaceId, 200) && bounded(w.repoKey, 300)
        && parseThreadId(w.threadId) !== null && typeof w.tainted === 'boolean'
        && ['active', 'blocked', 'completed'].includes(String(w.state))
        && Number.isSafeInteger(w.revision) && Number(w.revision) > 0
        && Number.isFinite(w.createdAt) && Number.isFinite(w.updatedAt)
        && validSteps(w))) {
      throw new Error('workflows.json has invalid workflow evidence');
    }
    const records = raw.workflows as unknown as BotWorkflow[];
    if (new Set(records.map((w) => w.id)).size !== records.length) throw new Error('duplicate workflow IDs');
    const owners = new Map<string, number>();
    for (const w of records) {
      const key = JSON.stringify([w.botId, w.workspaceId]);
      const count = (owners.get(key) ?? 0) + 1;
      if (count > WORKFLOW_LIMITS.records) throw new Error('workflow owner history exceeds its limit');
      owners.set(key, count);
    }
    this.records = copy(records);
  }

  list(botId: string, workspaceId: string): BotWorkflow[] {
    return copy(this.records.filter((w) => w.botId === botId && w.workspaceId === workspaceId));
  }
  get(id: string, botId: string, workspaceId: string): BotWorkflow | null {
    return copy(this.records.find((w) => w.id === id && w.botId === botId && w.workspaceId === workspaceId) ?? null);
  }

  /** Main's provenance lookup for synthetic ready facts; no plan text leaves here. */
  provenance(id: string): Pick<BotWorkflow, 'revision' | 'tainted'> | null {
    const workflow = this.records.find((w) => w.id === id);
    return workflow ? { revision: workflow.revision, tainted: workflow.tainted } : null;
  }

  private async update<T>(fn: (records: BotWorkflow[]) => T): Promise<T> {
    return this.serial(async () => {
      const next = copy(this.records);
      const result = fn(next);
      if (JSON.stringify(next) !== JSON.stringify(this.records)) {
        await this.write(this.file, { version: 1, workflows: next });
        this.records = next;
        // A listener never fails the write that already landed.
        for (const fn of changeListeners) { try { fn(); } catch { /* ignored */ } }
      }
      return copy(result);
    });
  }

  create(owner: Pick<BotWorkflow, 'botId' | 'workspaceId' | 'repoKey' | 'threadId' | 'tainted'>, input: WorkflowCreateParams): Promise<BotWorkflow> {
    if (!validateWorkflowInput(input)) return Promise.reject(new Error('invalid workflow definition'));
    input = redactStoredSecretsDeep({ clientWorkflowId: input.clientWorkflowId, title: input.title, steps: input.steps.map(({ title, prompt }) => ({ title, prompt })) });
    if (!validateWorkflowInput(input)) return Promise.reject(new Error('redacted workflow definition exceeds its limits'));
    return this.update((records) => {
      const id = `wf-${createHash('sha256').update(`${owner.botId}\0${owner.workspaceId}\0${input.clientWorkflowId}`).digest('hex').slice(0, 24)}`;
      const existing = records.find((w) => w.id === id);
      if (existing) {
        if (existing.title !== input.title || JSON.stringify(existing.steps.map(({ title, prompt }) => ({ title, prompt }))) !== JSON.stringify(input.steps)) {
          throw new Error('clientWorkflowId already names a different plan');
        }
        return existing;
      }
      if (records.filter((w) => w.botId === owner.botId && w.workspaceId === owner.workspaceId).length >= WORKFLOW_LIMITS.records) {
        throw new Error('this workflow owner history is full; existing records are retained to prevent replay');
      }
      if (records.length >= WORKFLOW_LIMITS.totalRecords) throw new Error('global workflow storage is full; existing records are retained to prevent replay');
      const at = this.now();
      const workflow: BotWorkflow = { ...owner, ...input, id, steps: input.steps.map((s) => ({ ...s, state: 'pending' })), state: 'active', revision: 1, createdAt: at, updatedAt: at };
      records.push(workflow);
      return workflow;
    });
  }

  /** Atomic claim under the same serialization as persistence. */
  claim(id: string, botId: string, workspaceId: string, dispatchKey: string): Promise<{ workflow: BotWorkflow; step: number } | null> {
    return this.update((records) => {
      const workflow = records.find((w) => w.id === id && w.botId === botId && w.workspaceId === workspaceId);
      if (!workflow || workflow.state !== 'active') return null;
      const index = workflow.steps.findIndex((s) => s.state !== 'completed');
      if (index < 0 || workflow.steps[index].state !== 'pending') return null;
      if (records.some((w) => w.botId === botId && w.workspaceId === workspaceId && w.steps.some((s) => s.dispatchKey === dispatchKey))) throw new Error('fan-out key already belongs to a workflow step');
      workflow.steps[index] = { ...workflow.steps[index], state: 'dispatching', dispatchKey };
      this.changed(workflow);
      return { workflow, step: index };
    });
  }

  /** Cancel advancement only. Worker processes and task ledger rows are untouched. */
  cancel(id: string, botId: string, workspaceId: string, expectedRevision: number): Promise<
    { ok: true; workflow: BotWorkflow } | { ok: false; code: 'not_found' | 'revision_conflict' }
  > {
    return this.update((records) => {
      const w = records.find((r) => r.id === id && r.botId === botId && r.workspaceId === workspaceId);
      if (!w) return { ok: false as const, code: 'not_found' as const };
      // A repeated cancellation is idempotent, including a lost IPC response.
      if (w.stoppedByOwner || w.state === 'completed') return { ok: true as const, workflow: w };
      if (w.revision !== expectedRevision) return { ok: false as const, code: 'revision_conflict' as const };
      const step = w.steps.find((s) => s.state !== 'completed')!;
      if (step.state !== 'blocked') {
        step.state = 'blocked';
        step.error = WORKFLOW_BLOCK.cancelled;
      }
      w.state = 'blocked'; w.stoppedByOwner = true;
      this.changed(w);
      return { ok: true as const, workflow: w };
    });
  }

  block(id: string, step: number, reason: string): Promise<BotWorkflow | null> {
    return this.update((records) => {
      const w = records.find((r) => r.id === id);
      if (!w || w.steps[step]?.state !== 'dispatching') return null;
      w.steps[step].state = 'blocked'; w.steps[step].error = reason.slice(0, 1_000);
      w.state = 'blocked'; this.changed(w);
      return w;
    });
  }

  /** The owner's stop is serialized with claims and creation. Work created
   *  after this operation is queued remains new work; old active plans stay
   *  blocked across restart, including plans with no task row yet. */
  blockFor(botId?: string): Promise<number> {
    return this.update((records) => {
      let count = 0;
      for (const w of records) {
        if (w.state !== 'active' || (botId !== undefined && w.botId !== botId)) continue;
        const step = w.steps.find((s) => s.state !== 'completed');
        if (!step) continue;
        step.state = 'blocked'; step.error = WORKFLOW_BLOCK.stopped;
        w.state = 'blocked'; w.stoppedByOwner = true;
        this.changed(w); count++;
      }
      return count;
    });
  }

  /** Task identity is main's stamp, additionally constrained by both owners. */
  reconcile(rows: readonly LedgerEntry[], recovering = false): Promise<BotWorkflow[]> {
    return this.update((records) => {
      const revisions = new Map(records.map((w) => [w.id, w.revision]));
      for (const w of records) {
        if (w.state !== 'active') continue;
        const step = w.steps.findIndex((s) => s.state !== 'completed');
        if (step < 0) continue;
        const s = w.steps[step];
        const matches = rows.filter((r) => r.ownerWorkspaceId === w.workspaceId
          && r.dispatch?.origin.kind === 'bot' && r.dispatch.origin.botId === w.botId
          && r.dispatch.workflow?.id === w.id && r.dispatch.workflow.step === step
          && r.dispatch.repoKey === w.repoKey);
        if (matches.length !== 1) {
          if (matches.length > 1 || (recovering && s.state !== 'pending')) {
            s.state = 'blocked'; s.error = matches.length > 1 ? WORKFLOW_BLOCK.multipleTasks : WORKFLOW_BLOCK.unknownDispatch;
            w.state = 'blocked'; this.changed(w);
          }
          // A prior ready wake may have finished before the pending step was
          // claimed. Give startup one fresh fact; ordinary transitions do not.
          if (recovering && s.state === 'pending') this.changed(w);
          continue;
        }
        const row = matches[0];
        if (!w.tainted && row.dispatch?.origin.tainted !== false) { w.tainted = true; this.changed(w); }
        if (s.taskId && s.taskId !== row.id) {
          s.state = 'blocked'; s.error = WORKFLOW_BLOCK.bindingChanged; w.state = 'blocked'; this.changed(w); continue;
        }
        const result = workflowTaskResult(row);
        const blocked = row.status === 'failed' || row.status === 'cancelled'
          || (row.status === 'completed' && !result);
        const state = result ? 'completed' : blocked ? 'blocked' : 'waiting';
        if (s.state !== state || s.taskId !== row.id || (!!result && s.result?.rev !== result.rev)) {
          s.dispatchKey ??= `reconciled:${row.id}`;
          s.taskId = row.id; s.state = state;
          if (result) s.result = result;
          if (blocked) { s.error = workflowTaskBlocked(row.id, row.status); w.state = 'blocked'; }
          if (w.steps.every((v) => v.state === 'completed')) w.state = 'completed';
          this.changed(w);
        }
      }
      // Startup revisits active work and newly blocked steps. Retained blocked
      // history must not consume another wake record on every restart.
      return records.filter((w) => (recovering && w.state === 'active') || w.revision !== revisions.get(w.id));
    });
  }

  flush(): Promise<void> { return this.serial(async () => undefined); }

  private changed(w: BotWorkflow): void { w.revision++; w.updatedAt = this.now(); }
}

let store: BotWorkflowStore | null = null;
export const getBotWorkflowStore = (): BotWorkflowStore | null => store;
export const setBotWorkflowStore = (value: BotWorkflowStore | null): void => { store = value; };
