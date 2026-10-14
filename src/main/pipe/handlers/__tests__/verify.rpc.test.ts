// verify.recordVerdict on the pipe: the principal and the repo come from the
// verified pane, never from params; the PR head, the verifier's checkout and
// its branch are checked before anything is recorded.
import { describe, it, expect, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import type { PrLaneFacts } from '../../../../shared/prReview';
import type { PrVerdictRecord } from '../../../../shared/prVerdict';
import { registerVerifyRpc, type VerifyRpcDeps } from '../verify.rpc';
import type { BotProfile } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { LedgerEntry, LedgerGateResult } from '../../../../shared/ledger';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
const CTX: RpcContext = { origin: 'local', clientName: 'codex-mcp-client', externalWire: true };
const HEAD = 'a'.repeat(40);
const INPUT = { prNumber: 7, headSha: HEAD, verdict: 'pass', summary: 'tests and lint pass' };
const FACTS = { number: 7, headRefOid: HEAD, headRefName: 'feat/x' } as PrLaneFacts;

function setup(over: Partial<VerifyRpcDeps> = {}, git: Record<string, string | null> = {}) {
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  const record = vi.fn<(r: PrVerdictRecord) => Promise<void>>(async () => undefined);
  const readPr = vi.fn(async () => FACTS);
  const repoKeyOf = vi.fn(async (cwd: string) => (cwd === '/verify/wt' ? 'github.com/o/r' : null));
  const answers: Record<string, string | null> = { 'rev-parse HEAD': HEAD, 'rev-parse --abbrev-ref HEAD': 'HEAD', ...git };
  registerVerifyRpc(router as never, {
    resolvePtyWorkspace: async (pty) => (pty === 'pty-1' ? 'ws-verifier' : null),
    paneCwd: (pty) => (pty === 'pty-1' ? '/verify/wt' : ''),
    repoKeyOf,
    readPr,
    git: async (args) => answers[args.join(' ')] ?? null,
    record,
    now: () => 42,
    ...over,
  });
  const call = (p: Record<string, unknown>, ctx: RpcContext = CTX) => (handlers.get('verify.recordVerdict') as Handler)(p, ctx);
  return { call, record, readPr, repoKeyOf };
}

describe('verify.recordVerdict', () => {
  it('records the verdict stamped with the verified pane, its workspace and its repo', async () => {
    const { call, record, readPr } = setup();
    const r = await call({ ...INPUT, senderPtyId: 'pty-1' });
    const expected: PrVerdictRecord = {
      version: 1, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
      principal: { workspaceId: 'ws-verifier', ptyId: 'pty-1', agent: 'codex' }, summary: 'tests and lint pass', at: 42,
    };
    expect(r).toEqual({ ok: true, record: expected });
    expect(record).toHaveBeenCalledWith(expected);
    expect(readPr).toHaveBeenCalledWith('/verify/wt', 'github.com/o/r', 7);
  });

  it('identity or a repo named in params is an unknown field, never used', async () => {
    const { call, record } = setup();
    for (const extra of [{ workspaceId: 'ws-evil' }, { repoKey: 'github.com/evil/r' }, { principal: { workspaceId: 'ws-evil' } }, { ptyId: 'pty-2' }]) {
      expect(await call({ ...INPUT, ...extra, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a brain, a hosted workspace and a caller with no verified pane', async () => {
    const { call, record } = setup();
    expect(await call({ ...INPUT, senderPtyId: 'pty-1' }, { ...CTX, commanderWorkspace: 'ws-1' })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await call({ ...INPUT, senderPtyId: 'pty-1' }, { ...CTX, hostedWorkspace: 'ws-1' } as RpcContext)).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await call({ ...INPUT })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await call({ ...INPUT, senderPtyId: 'pty-9' })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses when the PR head is not headSha', async () => {
    const { call, record } = setup({ readPr: async () => ({ ...FACTS, headRefOid: 'b'.repeat(40) }) });
    expect(await call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'head-mismatch' });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses when the PR cannot be read or the cwd is in no repo', async () => {
    expect(await setup({ readPr: async () => { throw new Error('gh'); } }).call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'pr-read-failed' });
    expect(await setup({ repoKeyOf: async () => null }).call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'no-repo' });
  });

  it('refuses when the verifier cwd does not have headSha checked out', async () => {
    for (const head of ['c'.repeat(40), null]) {
      const { call, record } = setup({}, { 'rev-parse HEAD': head });
      expect(await call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'checkout-mismatch' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('refuses a verifier on the PR branch itself, or whose branch cannot be read', async () => {
    const onBranch = setup({}, { 'rev-parse --abbrev-ref HEAD': 'feat/x' });
    expect(await onBranch.call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'on-pr-branch' });
    expect(onBranch.record).not.toHaveBeenCalled();
    const unread = setup({}, { 'rev-parse --abbrev-ref HEAD': null });
    expect(await unread.call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'checkout-mismatch' });
    // Another local branch at the same commit is a separate checkout: allowed.
    expect(await setup({}, { 'rev-parse --abbrev-ref HEAD': 'verify/7' }).call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: true });
  });

  it('a store that cannot write answers store-error', async () => {
    const { call } = setup({ record: async () => { throw new Error('disk'); } });
    expect(await call({ ...INPUT, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'store-error' });
  });
});

// ── The bot path (factory verifier) ─────────────────────────────────────────

const BOT = { workspaceId: 'ws-v', botId: 'bot-0a1b2c3d', role: 'verifier' as const };
const BOT_CTX: RpcContext = { origin: 'local', commanderWorkspace: 'ws-v', bot: BOT };
const TASK = 'task-verify-1';

function verifierProfile(over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id: BOT.botId, workspaceId: 'ws-v', role: 'verifier', name: 'Verifier', engine: { kind: 'claude-sdk' },
    triggers: [], budget: { ...DEFAULT_BOT_BUDGETS.verifier }, repo: { repoKey: 'o/r', repoPath: '/repo' },
    enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

function gate(over: Partial<LedgerGateResult> = {}): LedgerGateResult {
  return { exitCode: 0, tail: 'ok', at: 5, command: 'npm run lint && npm test', recordedBy: 'system', headSha: HEAD, ...over };
}

function row(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-v', title: 'verify #7', status: 'review_requested',
    rev: 3, updatedAt: 5, updatedBy: { kind: 'system' },
    dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'verify', checkout: { sha: HEAD, detached: true } },
    gate: gate(),
    ...over,
  } as LedgerEntry;
}

function botSetup(r: LedgerEntry | null = row(), profile: BotProfile | null = verifierProfile(), over: Partial<VerifyRpcDeps> = {}) {
  return setup({
    repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
    bot: { profile: (id) => (id === BOT.botId ? profile : null), ledgerRow: (id) => (r && id === r.id ? r : null) },
    ...over,
  });
}

const BOT_INPUT = { ...INPUT, evidence: { taskId: TASK } };

describe('verify.recordVerdict — bot path', () => {
  it('records a PASS stamped with the bot binding and the gate head from the ledger row', async () => {
    const { call, record, readPr } = botSetup();
    const r = await call(BOT_INPUT, BOT_CTX);
    const expected: PrVerdictRecord = {
      version: 2, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
      principal: { workspaceId: 'ws-v', botId: BOT.botId, agent: 'bot:verifier' },
      evidence: { taskId: TASK, gateHeadSha: HEAD }, summary: 'tests and lint pass', at: 42,
    };
    expect(r).toEqual({ ok: true, record: expected });
    expect(record).toHaveBeenCalledWith(expected);
    expect(readPr).toHaveBeenCalledWith('/repo', 'github.com/o/r', 7);
  });

  it('any enabled bot of the workspace with the repository records, whatever its role tag or template', async () => {
    for (const role of ['lead', 'triage', 'maintainer', 'moa'] as const) {
      const { call, record } = botSetup(row(), verifierProfile({ role, template: 'custom' }));
      expect(await call(BOT_INPUT, { ...BOT_CTX, bot: { ...BOT, role } }), role).toMatchObject({ ok: true });
      expect(record).toHaveBeenCalledTimes(1);
    }
  });

  it('a bot of another workspace, without a repository, or switched off records nothing', async () => {
    for (const profile of [verifierProfile({ workspaceId: 'ws-other' }), verifierProfile({ repo: undefined }), verifierProfile({ enabled: false }), null]) {
      const { call, record } = botSetup(row(), profile);
      expect((await call(BOT_INPUT, BOT_CTX)) as { ok: boolean }).toMatchObject({ ok: false });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('refusal matrix: every verdict the lane would not count is refused with the lane\'s reason', async () => {
    const cases: Array<[string, LedgerEntry | null, Record<string, unknown>, string]> = [
      ['no evidence', row(), { ...INPUT }, 'evidence-missing'],
      ['evidence with extra keys', row(), { ...INPUT, evidence: { taskId: TASK, gateHeadSha: HEAD } }, 'evidence-missing'],
      ['unknown task', null, BOT_INPUT, 'evidence-missing'],
      ['another bot dispatched it', row({ dispatch: { origin: { kind: 'bot', botId: 'bot-ffffffff' }, preset: 'verify', checkout: { sha: HEAD, detached: true } } }), BOT_INPUT, 'evidence-mismatch'],
      ['a pane dispatched it', row({ dispatch: { origin: { kind: 'pane' }, preset: 'verify', checkout: { sha: HEAD, detached: true } } }), BOT_INPUT, 'evidence-mismatch'],
      ['not the verify preset', row({ dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'repro' } }), BOT_INPUT, 'evidence-mismatch'],
      ['a branch checkout', row({ dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'verify' } }), BOT_INPUT, 'evidence-mismatch'],
      ['checked out another commit', row({ dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'verify', checkout: { sha: 'c'.repeat(40), detached: true } } }), BOT_INPUT, 'evidence-mismatch'],
      ['no gate recorded yet', row({ gate: undefined }), BOT_INPUT, 'evidence-mismatch'],
      ['a gate the worker wrote', row({ gate: gate({ recordedBy: 'worker' }) }), BOT_INPUT, 'evidence-mismatch'],
      ['a gate on another head', row({ gate: gate({ headSha: 'c'.repeat(40) }) }), BOT_INPUT, 'evidence-mismatch'],
      ['a gate on a dirty tree (no head)', row({ gate: gate({ headSha: undefined }) }), BOT_INPUT, 'evidence-mismatch'],
      ['a recorded skip', row({ gate: gate({ skipped: 'no_gate_command', command: 'none' }) }), BOT_INPUT, 'gate-skipped'],
      ['a PASS on a red gate', row({ gate: gate({ exitCode: 1 }) }), BOT_INPUT, 'gate-failed'],
      ['a PASS on a killed gate', row({ gate: gate({ exitCode: null }) }), BOT_INPUT, 'gate-failed'],
    ];
    for (const [label, r, input, code] of cases) {
      const { call, record } = botSetup(r);
      expect({ label, res: await call(input, BOT_CTX) }).toMatchObject({ label, res: { ok: false, code } });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('a FAIL may rest on a red gate, never on a skip or a mismatch', async () => {
    const fail = { ...BOT_INPUT, verdict: 'fail', summary: 'tests fail at head' };
    const red = botSetup(row({ gate: gate({ exitCode: 2 }) }));
    expect(await red.call(fail, BOT_CTX)).toMatchObject({ ok: true, record: { verdict: 'fail', evidence: { taskId: TASK, gateHeadSha: HEAD } } });
    expect(await botSetup(row({ gate: gate({ skipped: 'no_gate_command', command: 'none' }) })).call(fail, BOT_CTX)).toMatchObject({ code: 'gate-skipped' });
    expect(await botSetup(row({ gate: undefined })).call(fail, BOT_CTX)).toMatchObject({ code: 'evidence-mismatch' });
  });

  it('the PR is read fresh at headSha; repo and principal come from the profile and binding only', async () => {
    expect(await botSetup(row(), verifierProfile(), { readPr: async () => ({ ...FACTS, headRefOid: 'b'.repeat(40) }) }).call(BOT_INPUT, BOT_CTX))
      .toMatchObject({ ok: false, code: 'head-mismatch' });
    expect(await botSetup(row(), verifierProfile(), { readPr: async () => { throw new Error('gh'); } }).call(BOT_INPUT, BOT_CTX))
      .toMatchObject({ ok: false, code: 'pr-read-failed' });
    expect(await botSetup(row(), verifierProfile({ repo: undefined })).call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'no-repo' });
    expect(await botSetup(row(), verifierProfile({ enabled: false })).call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await botSetup(row(), verifierProfile({ workspaceId: 'ws-other' })).call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await botSetup(row(), null).call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'not-attributed' });
    const { call } = botSetup();
    for (const extra of [{ workspaceId: 'ws-evil' }, { repoKey: 'github.com/evil/r' }, { principal: { botId: 'bot-ffffffff' } }]) {
      expect(await call({ ...BOT_INPUT, ...extra }, BOT_CTX)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('a verdict refused because the head moved closes this bot\'s verify task at that head, and only that one', async () => {
    const moved = async () => ({ ...FACTS, headRefOid: 'b'.repeat(40) });
    const closes: Array<[string, string, string]> = [];
    const closer = async (taskId: string, botId: string, why: string) => { closes.push([taskId, botId, why]); return true; };
    const withCloser = (r: LedgerEntry | null) => setup({
      repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
      readPr: moved,
      bot: { profile: (id) => (id === BOT.botId ? verifierProfile() : null), ledgerRow: (id) => (r && id === r.id ? r : null), closeVerifyTask: closer },
    });
    const stale = withCloser(row());
    expect(await stale.call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'head-mismatch' });
    expect(stale.record).not.toHaveBeenCalled();
    expect(closes).toEqual([[TASK, BOT.botId, expect.stringContaining('PR head moved past')]]);
    closes.length = 0;
    // Another bot's task, a task at another commit, another preset, or no task: nothing closes.
    for (const r of [
      row({ dispatch: { origin: { kind: 'bot', botId: 'bot-ffffffff' }, preset: 'verify', checkout: { sha: HEAD, detached: true } } }),
      row({ dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'verify', checkout: { sha: 'c'.repeat(40), detached: true } } }),
      row({ dispatch: { origin: { kind: 'bot', botId: BOT.botId }, preset: 'repro', checkout: { sha: HEAD, detached: true } } }),
      null,
    ]) {
      expect(await withCloser(r).call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'head-mismatch' });
    }
    expect(closes).toEqual([]);
    // A recorded verdict does not close here (the record hook does), and a closer that fails changes no answer.
    const ok = setup({
      repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
      bot: { profile: () => verifierProfile(), ledgerRow: () => row(), closeVerifyTask: closer },
    });
    expect(await ok.call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: true });
    expect(closes).toEqual([]);
    // A bot disabled or moved off its repo while the PR was read closes nothing.
    for (const after of [verifierProfile({ enabled: false }), verifierProfile({ repo: { repoKey: 'o/r', repoPath: '/elsewhere' } }), null]) {
      let reads = 0;
      const changed = setup({
        repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
        readPr: moved,
        bot: { profile: () => (reads++ === 0 ? verifierProfile() : after), ledgerRow: () => row(), closeVerifyTask: closer },
      });
      expect(await changed.call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'head-mismatch' });
    }
    expect(closes).toEqual([]);
    const failing = setup({
      repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
      readPr: moved,
      bot: { profile: () => verifierProfile(), ledgerRow: () => row(), closeVerifyTask: async () => { throw new Error('ledger'); } },
    });
    expect(await failing.call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'head-mismatch' });
  });

  it('a bot disabled or moved while the PR was being read records nothing', async () => {
    for (const after of [verifierProfile({ enabled: false }), verifierProfile({ repo: { repoKey: 'o/r', repoPath: '/elsewhere' } }), null]) {
      let calls = 0;
      const { call, record } = setup({
        repoKeyOf: async (p: string) => (p === '/repo' ? 'github.com/o/r' : null),
        bot: { profile: () => (calls++ === 0 ? verifierProfile() : after), ledgerRow: () => row() },
      });
      expect(await call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'not-attributed' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('the store failing is a refusal, not a throw', async () => {
    const { call } = botSetup(row(), verifierProfile(), { record: async () => { throw new Error('disk'); } });
    expect(await call(BOT_INPUT, BOT_CTX)).toMatchObject({ ok: false, code: 'store-error' });
  });
});
