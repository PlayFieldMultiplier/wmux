// verify.recordVerdict on the pipe: the principal and the repo come from the
// verified pane, never from params; the PR head, the verifier's checkout and
// its branch are checked before anything is recorded.
import { describe, it, expect, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import type { PrLaneFacts } from '../../../../shared/prReview';
import type { PrVerdictRecord } from '../../../../shared/prVerdict';
import { registerVerifyRpc, type VerifyRpcDeps } from '../verify.rpc';

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
