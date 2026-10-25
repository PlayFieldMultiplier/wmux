// The chat-v2 driver for Codex: one `codex app-server --listen stdio://`
// process per chat record, speaking JSON-RPC over newline-delimited JSON.
// It maps app-server notifications to HarnessEvents and hands command,
// file-change and permission approvals and request_user_input to the host as
// decisions; each request gets exactly one reply, written by `answer`.
//
// Approval rules (see codexProtocol.ts for what was measured):
//   - the thread always runs `approvalPolicy: on-request`, `sandbox:
//     workspace-write`, whatever the record's mode; a bypass record is refused;
//   - Approve sends `accept` only, never a session-wide or policy-amending
//     grant; Deny sends `decline`, or `cancel` where the request does not take
//     `decline` (that card says it stops the turn);
//   - a request nobody can answer is declined at once;
//   - a file-change card always shows the diff it approves: when the diff
//     arrives or changes after the card, the decision is raised again for the
//     same request id, and the host replaces the card.
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { CHATV2_PROVIDER_SESSION_ID } from '../../../../shared/chatv2/ipc';
import { formQuestions, replyFromAnswers } from '../../../../shared/chatv2/questions';
import type { TurnOutcome } from '../../../../shared/chatv2/session';
import { questionPromptTitle } from '../../../../shared/chatv2/userQuestion';
import type { NativeDecisionOutcome, NativeDecisionReply } from '../../../approvals/types';
import { whichOnPath } from '../../../web/agentLaunch';
import { ChildBackend } from '../childBackend';
import { asRecord, parseJsonLine } from '../claude/claudeProtocol';
import type { ChatV2Driver, ChatV2DriverSink, ChatV2DriverStart, ChatV2DriverTurn } from '../types';
import {
  CODEX_APPROVAL_POLICY,
  CODEX_CANCEL_LABEL,
  CODEX_MIN_VERSION,
  CODEX_SANDBOX,
  changeSummary,
  changeTitle,
  changesKey,
  codexQuestions,
  codexSpawnArgs,
  codexVersionFromUserAgent,
  codexVersionSupported,
  commandSummary,
  denyDecision,
  fileChangePreview,
  fileChangesOf,
  permissionsCard,
  str,
  type CodexFileChange,
  type CodexQuestionSet,
} from './codexProtocol';

/** initialize, thread/start and turn/start must each answer within this long. */
export const CODEX_CALL_TIMEOUT_MS = 20_000;
/** What `daemon.chatv2.answer` can name; a request id outside it is declined at once. */
const ANSWERABLE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Stderr kept for a failed start's message. */
const STDERR_TAIL_BYTES = 2_048;
/** Output kept on a finished command row. */
const OUTPUT_TAIL_CHARS = 4_000;
const LOADING_SUMMARY = 'File changes (details loading)';

type RpcId = string | number;

type Pending =
  | { kind: 'command'; rpcId: RpcId; deny: 'decline' | 'cancel' }
  | { kind: 'fileChange'; rpcId: RpcId; itemId: string; deny: 'decline' | 'cancel'; shown: string }
  | { kind: 'permissions'; rpcId: RpcId; grant: Record<string, unknown> }
  | { kind: 'questions'; rpcId: RpcId; set: CodexQuestionSet };

export interface CodexDriverOptions {
  /** The executable. Default: `codex` resolved on the child env's PATH (Windows: by the spawn). */
  command?: string;
  backend?: ChildBackend;
}

export class CodexDriver implements ChatV2Driver {
  readonly agent = 'codex' as const;
  private readonly backend: ChildBackend;
  private sink: ChatV2DriverSink | null = null;
  private threadId = '';
  private nextRpcId = 0;
  private readonly calls = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private initialized = false;
  private stopping = false;
  private exitedOnce = false;
  private stderrTail = '';

  // Requests waiting on an answer, by request id; answered or dropped ids stay settled.
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Set<string>();

  // Per-turn state.
  private activeTurn = false;
  private turnId = '';
  private interruptPending = false;
  private readonly changes = new Map<string, CodexFileChange[]>();
  private readonly streamed = new Map<string, string>();

  constructor(private readonly options: CodexDriverOptions = {}) {
    this.backend = options.backend ?? new ChildBackend();
  }

  get pid(): number | undefined {
    return this.backend.pid;
  }

  async start(spec: ChatV2DriverStart, sink: ChatV2DriverSink): Promise<void> {
    if (this.sink) throw new Error('Driver already started');
    if (spec.mode === 'bypass') throw new Error('Codex chat always asks before it runs a command or changes a file; it has no bypass mode.');
    this.sink = sink;
    const command = this.options.command
      ?? (process.platform === 'win32' ? 'codex' : await whichOnPath('codex', spec.env.PATH ?? ''));
    if (!command) throw new Error('Codex is not installed: `codex` was not found on PATH.');
    await this.backend.start(command, codexSpawnArgs(spec.providerSession.id), spec.cwd, spec.env, {
      line: (line) => this.handleLine(line),
      exit: (info) => this.handleExit(info),
      stderr: (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES); },
    });
    try {
      if (this.stopping) throw new Error('Codex was stopped during startup.');
      const init = asRecord(await this.call('initialize', { clientInfo: { name: 'wmux_chat', title: 'wmux', version: '1.0.0' } }));
      const version = codexVersionFromUserAgent(init?.userAgent);
      if (!codexVersionSupported(version)) {
        throw new Error(`Codex ${version ?? '(unknown version)'} is too old for chat; update to ${CODEX_MIN_VERSION} or later.`);
      }
      await this.notify('initialized', {});
      const resume = spec.providerSession.mode === 'resume';
      const params: Record<string, unknown> = {
        cwd: spec.cwd,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox: CODEX_SANDBOX,
        ...(spec.model ? { model: spec.model } : {}),
        ...(resume ? { threadId: spec.providerSession.id } : {}),
      };
      const thread = asRecord(asRecord(await this.call(resume ? 'thread/resume' : 'thread/start', params))?.thread);
      const threadId = str(thread?.id);
      if (!CHATV2_PROVIDER_SESSION_ID.test(threadId) || (resume && threadId !== spec.providerSession.id)) {
        throw new Error('Codex answered with a different conversation.');
      }
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      if (turns.some((turn) => asRecord(turn)?.status === 'inProgress')) {
        throw new Error('This Codex conversation is still running somewhere else.');
      }
      this.threadId = threadId;
      this.initialized = true;
    } catch (error) {
      await this.stop().catch(() => undefined);
      const detail = this.stderrTail.trim().split('\n').pop()?.slice(0, 300);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail && !this.initialized ? `${message} ${detail}` : message);
    }
    this.emit({ type: 'session.providerBound', providerSessionId: this.threadId });
    this.emit({ type: 'session.started' });
  }

  async send(turn: ChatV2DriverTurn): Promise<void> {
    if (!this.backend.alive || !this.initialized) throw new Error('Codex is not running.');
    const input: Array<Record<string, unknown>> = [{ type: 'text', text: turn.text }];
    for (const attachment of turn.attachments) input.push({ type: 'localImage', path: attachment.path });
    this.resetTurn();
    this.activeTurn = true;
    try {
      const started = asRecord(asRecord(await this.call('turn/start', { threadId: this.threadId, input }))?.turn);
      this.noteTurn(str(started?.id));
    } catch (error) {
      this.activeTurn = false;
      throw error;
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.activeTurn || !this.backend.alive) return false;
    if (!this.turnId) {
      // turn/start has not answered yet: stop the turn as soon as it has an id.
      this.interruptPending = true;
      return true;
    }
    await this.sendInterrupt();
    return true;
  }

  async answer(requestId: string, reply: NativeDecisionReply): Promise<NativeDecisionOutcome> {
    const pending = this.pending.get(requestId);
    if (!pending || this.settled.has(requestId)) return 'not-found';
    const approve = reply.decision === 'approve';
    // A card raised before its diff arrived approves nothing until it shows one.
    if (approve && pending.kind === 'fileChange' && !pending.shown) return 'changed';
    // Claimed before the write: a second answer for this id never writes.
    this.pending.delete(requestId);
    this.settled.add(requestId);
    let result: Record<string, unknown>;
    if (pending.kind === 'command' || pending.kind === 'fileChange') {
      result = { decision: approve ? 'accept' : pending.deny };
    } else if (pending.kind === 'permissions') {
      result = { permissions: approve ? pending.grant : {}, scope: 'turn' };
    } else {
      const answered = approve ? replyFromAnswers(pending.set.questions, reply.answers) : { kind: 'skipped' as const };
      const answers: Record<string, { answers: string[] }> = {};
      if (answered.kind === 'answered') {
        pending.set.questions.forEach((question, index) => {
          const native = pending.set.native[index];
          const picked = (answered.answers[question.id] ?? []).map((key) => native.labels[Number(key) - 1]).filter(Boolean);
          const custom = answered.custom?.[question.id];
          const all = custom ? [...picked, custom] : picked;
          if (all.length) answers[native.id] = { answers: all };
        });
      }
      result = { answers };
    }
    try {
      await this.backend.write(JSON.stringify({ id: pending.rpcId, result }));
      return 'ok';
    } catch {
      // Released so the request stays answerable. A write that timed out also
      // killed the child (ChildBackend.write), and its exit settles the request.
      if (!this.backend.alive) return 'not-found';
      this.settled.delete(requestId);
      this.pending.set(requestId, pending);
      return 'uncertain';
    }
  }

  /** Rejects when the process was not seen to exit: it may still be running. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (!(await this.backend.stop())) throw new Error('Codex did not exit.');
  }

  // --- JSON-RPC -------------------------------------------------------------

  private emit(event: HarnessEvent): void {
    this.sink?.event(event);
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.nextRpcId += 1;
    const id = this.nextRpcId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Codex did not answer ${method}.`));
      }, CODEX_CALL_TIMEOUT_MS);
      timer.unref();
      this.calls.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.backend.write(JSON.stringify({ id, method, params })).catch((error: unknown) => {
        this.calls.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.calls.delete(id);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.backend.write(JSON.stringify({ method, params }));
  }

  private reply(id: RpcId, result: Record<string, unknown>): void {
    void this.backend.write(JSON.stringify({ id, result })).catch(() => undefined);
  }

  private replyError(id: RpcId): void {
    void this.backend.write(JSON.stringify({ id, error: { code: -32601, message: 'Not supported by this client' } })).catch(() => undefined);
  }

  private handleExit(info: { code: number | null; signal: string | null }): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    for (const call of this.calls.values()) call.reject(new Error('Codex exited.'));
    this.calls.clear();
    for (const requestId of this.pending.keys()) this.settled.add(requestId);
    this.pending.clear();
    this.activeTurn = false;
    const sink = this.sink;
    if (!sink) return;
    if (this.initialized) sink.event({ type: 'session.ended', code: info.code });
    sink.exited(info);
  }

  private handleLine(line: string): void {
    const msg = parseJsonLine(line);
    if (!msg) return;
    const method = str(msg.method);
    const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : undefined;
    if (!method && typeof id === 'number') {
      const call = this.calls.get(id);
      if (!call) return;
      this.calls.delete(id);
      const error = asRecord(msg.error);
      if (error) call.reject(new Error(str(error.message) || 'Codex refused the request.'));
      else call.resolve(msg.result);
      return;
    }
    const params = asRecord(msg.params) ?? {};
    if (method && id !== undefined) {
      this.handleRequest(method, params, id);
      return;
    }
    if (method && this.initialized && !this.stopping && str(params.threadId) === this.threadId) this.handleNotification(method, params);
  }

  // --- turn ---------------------------------------------------------------

  private resetTurn(): void {
    this.turnId = '';
    this.interruptPending = false;
    this.changes.clear();
    this.streamed.clear();
  }

  private noteTurn(turnId: string): void {
    if (!turnId || this.turnId === turnId) return;
    this.turnId = turnId;
    this.emit({ type: 'turn.started', providerTurnId: turnId });
    if (this.interruptPending) {
      this.interruptPending = false;
      void this.sendInterrupt().catch(() => undefined);
    }
  }

  private async sendInterrupt(): Promise<void> {
    await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  private finishTurn(turn: Record<string, unknown>): void {
    if (!this.activeTurn) return;
    if (str(turn.id) && this.turnId && str(turn.id) !== this.turnId) return;
    this.activeTurn = false;
    const status = str(turn.status);
    const outcome: TurnOutcome = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed';
    const error = str(asRecord(turn.error)?.message);
    if (outcome === 'failed' && error) this.emit({ type: 'session.error', message: error });
    this.emit({ type: 'message.completed' });
    this.emit({ type: 'reasoning.completed' });
    // Requests a finished turn left behind can no longer be answered.
    for (const requestId of this.pending.keys()) {
      this.settled.add(requestId);
      this.sink?.decisionGone(requestId);
    }
    this.pending.clear();
    this.emit({ type: 'turn.ended', outcome });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started':
        if (this.activeTurn) this.noteTurn(str(asRecord(params.turn)?.id));
        return;
      case 'turn/completed':
        this.finishTurn(asRecord(params.turn) ?? {});
        return;
      case 'item/agentMessage/delta': {
        const itemId = str(params.itemId);
        const delta = str(params.delta);
        if (!itemId || !delta) return;
        this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + delta);
        this.emit({ type: 'message.delta', text: delta });
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        const delta = str(params.delta);
        if (delta) this.emit({ type: 'reasoning.delta', text: delta });
        return;
      }
      case 'item/started':
      case 'item/completed':
        this.handleItem(asRecord(params.item), method === 'item/completed');
        return;
      case 'item/fileChange/patchUpdated': {
        const itemId = str(params.itemId);
        const changes = fileChangesOf(params.changes);
        if (itemId && changes.length) this.noteChanges(itemId, changes, 'in_progress');
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = String(params.requestId ?? '');
        if (this.pending.delete(requestId)) {
          this.settled.add(requestId);
          this.sink?.decisionGone(requestId);
        }
        return;
      }
      default:
        return;
    }
  }

  private handleItem(item: Record<string, unknown> | null, completed: boolean): void {
    const id = str(item?.id);
    if (!item || !id || !this.activeTurn) return;
    const type = str(item.type);
    const status = str(item.status);
    if (type === 'agentMessage') {
      if (!completed) return;
      // A message that arrived whole (no deltas) still reaches the transcript.
      const text = str(item.text);
      const sent = this.streamed.get(id) ?? '';
      if (text.startsWith(sent) && text.length > sent.length) this.emit({ type: 'message.delta', text: text.slice(sent.length) });
      this.emit({ type: 'message.completed' });
      return;
    }
    if (type === 'reasoning') {
      if (completed) this.emit({ type: 'reasoning.completed' });
      return;
    }
    if (type === 'plan') {
      if (completed && str(item.text)) this.emit({ type: 'plan', text: str(item.text), key: id, streaming: false });
      return;
    }
    if (type === 'commandExecution') {
      const command = str(item.command);
      if (!completed) {
        this.emit({ type: 'tool.started', callId: id, title: command || 'Run a command', kind: 'execute', status: 'in_progress', ...(command ? { preview: { kind: 'shell', command } } : {}) });
        return;
      }
      const output = str(item.aggregatedOutput);
      const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
      const detail = status === 'declined' ? 'Declined' : output ? output.slice(-OUTPUT_TAIL_CHARS) : exit !== null ? `Exit code ${exit}` : '';
      this.emit({ type: 'tool.updated', callId: id, status: status === 'completed' ? 'completed' : 'failed', ...(detail ? { detail } : {}) });
      return;
    }
    if (type === 'fileChange') {
      const changes = fileChangesOf(item.changes);
      if (!completed) {
        if (changes.length) this.noteChanges(id, changes, 'in_progress', true);
        else this.emit({ type: 'tool.started', callId: id, title: 'Edit files', kind: 'edit', status: 'in_progress' });
        return;
      }
      this.emit({
        type: 'tool.updated',
        callId: id,
        status: status === 'completed' ? 'completed' : 'failed',
        ...(status === 'declined' ? { detail: 'Declined' } : {}),
        ...(changes.length ? { preview: fileChangePreview(changes), paths: changes.map((c) => c.movePath ?? c.path) } : {}),
      });
      return;
    }
    if (type === 'userMessage' || type === 'hookPrompt' || type === 'contextCompaction') return;
    const title = type === 'mcpToolCall' ? `${str(item.server)}: ${str(item.tool)}`
      : type === 'webSearch' ? `Search ${str(item.query)}`.trim()
      : str(item.tool) || type;
    if (!completed) this.emit({ type: 'tool.started', callId: id, title, kind: type === 'webSearch' ? 'search' : 'other', status: 'in_progress' });
    else this.emit({ type: 'tool.updated', callId: id, status: status === 'failed' || item.error ? 'failed' : 'completed' });
  }

  /**
   * A fileChange item's diff, new or changed. The row shows it; a card
   * already raised for it is raised again when the diff it showed is no
   * longer the diff being approved.
   */
  private noteChanges(itemId: string, changes: CodexFileChange[], status: string, started = false): void {
    const known = this.changes.has(itemId);
    this.changes.set(itemId, changes);
    const preview = fileChangePreview(changes);
    const paths = changes.map((c) => c.movePath ?? c.path);
    if (started && !known) this.emit({ type: 'tool.started', callId: itemId, title: changeTitle(changes), kind: 'edit', status, ...(preview ? { preview } : {}), paths });
    else this.emit({ type: 'tool.updated', callId: itemId, title: changeTitle(changes), kind: 'edit', status, ...(preview ? { preview } : {}), paths });
    for (const [requestId, pending] of this.pending) {
      if (pending.kind !== 'fileChange' || pending.itemId !== itemId) continue;
      const key = changesKey(changes);
      if (pending.shown === key) continue;
      pending.shown = key;
      this.raiseFileChange(requestId, pending, changes);
    }
  }

  // --- requests -----------------------------------------------------------

  /** Fail closed: the reply that grants nothing for each request kind. */
  private refuse(method: string, id: RpcId): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') this.reply(id, { decision: 'decline' });
    else if (method === 'item/permissions/requestApproval') this.reply(id, { permissions: {}, scope: 'turn' });
    else if (method === 'item/tool/requestUserInput') this.reply(id, { answers: {} });
    else this.replyError(id);
  }

  private handleRequest(method: string, params: Record<string, unknown>, id: RpcId): void {
    const requestId = String(id);
    // A request already answered (or already waiting) gets no second reply.
    if (this.settled.has(requestId) || this.pending.has(requestId)) return;
    const sink = this.sink;
    if (!sink || !this.initialized || this.stopping || !this.activeTurn || str(params.threadId) !== this.threadId
      || (this.turnId && str(params.turnId) && str(params.turnId) !== this.turnId) || !ANSWERABLE_REQUEST_ID.test(requestId)) {
      this.settled.add(requestId);
      this.refuse(method, id);
      return;
    }
    const itemId = str(params.itemId);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const deny = denyDecision(params.availableDecisions);
        this.pending.set(requestId, { kind: 'command', rpcId: id, deny });
        const command = str(params.command);
        sink.decision({ kind: 'permission', requestId, question: 'Run this command?', toolName: 'Shell', summary: commandSummary(params), ...(deny === 'cancel' ? { denyLabel: CODEX_CANCEL_LABEL } : {}) });
        this.emit({ type: 'approval.requested', requestId, title: command || 'Run a command', kind: 'execute', ...(itemId ? { callId: itemId } : {}), ...(command ? { preview: { kind: 'shell', command } } : {}) });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const changes = this.changes.get(itemId) ?? [];
        const pending: Extract<Pending, { kind: 'fileChange' }> = {
          kind: 'fileChange', rpcId: id, itemId, deny: denyDecision(params.availableDecisions), shown: changes.length ? changesKey(changes) : '',
        };
        this.pending.set(requestId, pending);
        // Raised at once even before the diff is known; it is raised again when the diff arrives.
        this.raiseFileChange(requestId, pending, changes);
        return;
      }
      case 'item/permissions/requestApproval': {
        const card = permissionsCard(params.permissions);
        if (!card.ok) {
          this.settled.add(requestId);
          this.reply(id, { permissions: {}, scope: 'turn' });
          this.emit({ type: 'status', text: `Codex asked for more permissions and was refused (${card.reason}).` });
          return;
        }
        this.pending.set(requestId, { kind: 'permissions', rpcId: id, grant: card.grant });
        sink.decision({ kind: 'permission', requestId, question: 'Allow these permissions for this turn?', toolName: 'Permissions', summary: card.summary });
        this.emit({ type: 'approval.requested', requestId, title: str(params.reason) || 'Grant permissions for this turn', kind: 'other' });
        return;
      }
      case 'item/tool/requestUserInput': {
        const set = codexQuestions(params.questions);
        if (!set) {
          this.settled.add(requestId);
          this.reply(id, { answers: {} });
          this.emit({ type: 'status', text: 'Codex asked a question chat cannot show (a secret or an unreadable one); it was skipped.' });
          return;
        }
        this.pending.set(requestId, { kind: 'questions', rpcId: id, set });
        sink.decision({ kind: 'questions', requestId, questions: formQuestions(set.questions) });
        this.emit({ type: 'question.asked', requestId, title: questionPromptTitle(set.questions), questions: set.questions, ...(itemId ? { callId: itemId } : {}) });
        return;
      }
      default:
        // MCP elicitation, dynamic tool calls, auth refreshes and the legacy
        // approval methods: nothing here grants them.
        this.settled.add(requestId);
        this.refuse(method, id);
    }
  }

  private raiseFileChange(requestId: string, pending: Extract<Pending, { kind: 'fileChange' }>, changes: CodexFileChange[]): void {
    const preview = fileChangePreview(changes);
    this.sink?.decision({
      kind: 'permission',
      requestId,
      question: 'Apply these file changes?',
      toolName: 'Edit',
      summary: changes.length ? changeSummary(changes) : LOADING_SUMMARY,
      ...(pending.deny === 'cancel' ? { denyLabel: CODEX_CANCEL_LABEL } : {}),
    });
    this.emit({
      type: 'approval.requested',
      requestId,
      title: changes.length ? changeTitle(changes) : 'Edit files',
      kind: 'edit',
      ...(pending.itemId ? { callId: pending.itemId } : {}),
      ...(preview ? { preview } : {}),
    });
  }
}
