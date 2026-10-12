// The merge executor on a real outbox (tmp dir): journal first, fresh read,
// lane, merge(), and how each GitHub answer settles the row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrLaneFacts, PrWriteResult } from '../../../shared/prReview';
import { MoaEffectStore } from '../moaEffectStore';
import { MoaMergeExecutor, laneAuthorize, PREDICATES_BY_APPROVER, type LaneAuthorizeInputs, type MoaMergeExecutorPorts } from '../moaMergeExecutor';
import type { MergeEffect } from '../../../shared/moaDecision';
import type { LaneEvidenceRow } from '../moaMergeLane';
import { PrVerdictStore } from '../../github/prVerdictStore';
import type { PrVerdictRecord } from '../../../shared/prVerdict';

const HEAD = 'a'.repeat(40);
const FACTS: PrLaneFacts = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main',
  author: 'owner', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-exec-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const VERDICT = (verdict: 'pass' | 'fail', workspaceId = 'ws-verifier'): PrVerdictRecord => ({
  version: 1, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict,
  principal: { workspaceId, ptyId: 'pty-v', agent: 'claude' }, summary: 'checked', at: Date.now(),
});

async function setup(mergeResult: PrWriteResult, approvedBy: 'owner' | 'moa-auto' = 'moa-auto', facts: PrLaneFacts = FACTS) {
  const verdicts = new PrVerdictStore(dir);
  await verdicts.record(VERDICT('pass'));
  const effects = new MoaEffectStore(dir);
  const e = await effects.enqueue({
    decisionId: 'moa-d-00000000-0000-4000-8000-000000000001', repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 7, expectHead: HEAD, approvedBy,
  });
  const state = { facts };
  const merge = vi.fn(async () => mergeResult);
  const exec = new MoaMergeExecutor({
    effects,
    facts: { readFresh: async () => state.facts },
    merge,
    laneContext: async (eff) => ({
      trustedAuthors: ['owner'], askerBranches: ['feat/x'],
      verdicts: await verdicts.list(eff.repoKey, eff.prNumber).catch(() => null), authorWorkspaces: ['ws-author'],
    }),
    authorize: () => null,
  });
  return { effects, e, exec, merge, state, verdicts };
}

describe('MoaMergeExecutor', () => {
  it('a gh error after the claim is uncertain; reconcile reads it again and the retry re-runs the lane', async () => {
    const { effects, e, exec, merge } = await setup({ ok: false, code: 'error', message: 'network' });
    expect(await exec.run(e.id)).toMatchObject({ status: 'uncertain', reason: 'merge-error', attempt: 1 });
    merge.mockResolvedValueOnce({ ok: true });
    await exec.reconcileAll();
    expect(effects.get(e.id)).toMatchObject({ status: 'done', attempt: 2 });
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it('a retry reads the verdict store again: a FAIL recorded after the first try stops it', async () => {
    const { effects, e, exec, merge, verdicts } = await setup({ ok: false, code: 'error', message: 'network' });
    expect(await exec.run(e.id)).toMatchObject({ status: 'uncertain', reason: 'merge-error' });
    await verdicts.record(VERDICT('fail', 'ws-other'));
    merge.mockResolvedValueOnce({ ok: true });
    await exec.reconcileAll();
    expect(effects.get(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdict-fail', attempt: 2 });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('an unreadable verdict store refuses an auto merge', async () => {
    const { e, exec, merge } = await setup({ ok: true });
    fs.writeFileSync(path.join(dir, 'pr-verdicts.json'), '{not json');
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdicts-unreadable' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('blocked and moved are refusals, never retried', async () => {
    const blocked = await setup({ ok: false, code: 'blocked', reason: 'draft', message: 'draft' } as PrWriteResult);
    expect(await blocked.exec.run(blocked.e.id)).toMatchObject({ status: 'refused', reason: 'blocked-draft' });
    await blocked.exec.reconcileAll();
    expect(blocked.merge).toHaveBeenCalledTimes(1);
  });

  it('a moa-auto effect re-runs every predicate on the fresh read; an owner one only head-unchanged', async () => {
    const outside = { ...FACTS, author: 'outsider' };
    const auto = await setup({ ok: true }, 'moa-auto', outside);
    expect(await auto.exec.run(auto.e.id)).toMatchObject({ status: 'refused', reason: 'author-trusted:external-author' });
    expect(auto.merge).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const owner = await setup({ ok: true }, 'owner', outside);
    expect(await owner.exec.run(owner.e.id)).toMatchObject({ status: 'done' });
  });

  it('the journal row is on disk (inFlight) before merge() runs', async () => {
    const { e, exec, merge } = await setup({ ok: true });
    merge.mockImplementationOnce(async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'moa-delegate', 'effects.json'), 'utf8')) as { effects: Array<{ status: string }> };
      expect(saved.effects[0]?.status).toBe('inFlight');
      return { ok: true };
    });
    expect(await exec.run(e.id)).toMatchObject({ status: 'done' });
  });

  it('an already-merged PR at the expected head settles done without merging', async () => {
    const { e, exec, merge } = await setup({ ok: true }, 'moa-auto', { ...FACTS, state: 'MERGED', mergeCommitOid: 'b'.repeat(40) });
    expect(await exec.run(e.id)).toMatchObject({ status: 'done', mergeCommitOid: 'b'.repeat(40) });
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('approver → predicates (R1)', () => {
  it('owner re-runs head-unchanged only; moa-auto and lane run every lane predicate', () => {
    expect(PREDICATES_BY_APPROVER.owner).toEqual(['head-unchanged']);
    expect(PREDICATES_BY_APPROVER['moa-auto']).toContain('verifier-pass-at-head');
    expect(PREDICATES_BY_APPROVER.lane).toEqual(PREDICATES_BY_APPROVER['moa-auto']);
  });

  it('an approver outside the table is refused, never treated as the owner', async () => {
    const { effects, e, merge } = await setup({ ok: true }, 'owner');
    const authorize = vi.fn(() => null);
    for (const approvedBy of ['admin', 'constructor', undefined]) {
      const rows = new Map<string, MergeEffect>([[e.id, { ...e, status: 'pending' }]]);
      const fake = {
        claim: async (id: string) => ({ ...rows.get(id), status: 'inFlight', attempt: 1, approvedBy }),
        finish: async (id: string, status: string, reason?: string) => ({ ...rows.get(id), status, reason }),
        get: (id: string) => rows.get(id) ?? null,
        list: () => [...rows.values()],
      } as unknown as typeof effects;
      const exec = new MoaMergeExecutor({
        effects: fake, facts: { readFresh: async () => FACTS }, merge,
        laneContext: async () => ({ trustedAuthors: ['owner'], askerBranches: ['feat/x'], verdicts: [], authorWorkspaces: [] }),
        authorize,
      });
      expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'unknown-approver' });
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('laneAuthorize', () => {
  const on: LaneAuthorizeInputs = { factoryEnabled: true, killSwitch: false, dailyCap: 3 };
  it('allows only with the factory on, the kill switch off and room under the daily cap', () => {
    expect(laneAuthorize(on, 0)).toBeNull();
    expect(laneAuthorize(on, 2)).toBeNull();
    expect(laneAuthorize(on, 3)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, dailyCap: 0 }, 0)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, dailyCap: Number.NaN }, 0)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, factoryEnabled: false }, 0)).toBe('factory-disabled');
    expect(laneAuthorize({ ...on, killSwitch: true }, 0)).toBe('lane-paused');
    expect(laneAuthorize(null, 0)).toBe('lane-inputs-unreadable');
  });
});

describe('lane effects', () => {
  const ROW: LaneEvidenceRow = {
    taskId: 'task-1', origin: { kind: 'bot', botId: 'bot-v' }, preset: 'verify', checkout: { sha: HEAD, detached: true },
    gate: { exitCode: 0, tail: '', at: 1, command: 'bash scripts/verify.sh', recordedBy: 'system', headSha: HEAD },
  };
  const BOT_PASS: PrVerdictRecord = {
    version: 2, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
    principal: { workspaceId: 'ws-verifier', botId: 'bot-v', agent: 'claude' }, evidence: { taskId: 'task-1', gateHeadSha: HEAD },
    summary: 'checked', at: Date.now(),
  };
  const LANE_FACTS: PrLaneFacts = { ...FACTS, headRefName: 'wtask/fix-x-abc123' };

  async function laneSetup(opts: {
    facts?: PrLaneFacts;
    verdicts?: PrVerdictRecord[];
    inputs?: LaneAuthorizeInputs | null;
    wired?: boolean;
    updateBranch?: MoaMergeExecutorPorts['updateBranch'];
  } = {}) {
    const effects = new MoaEffectStore(dir);
    const state = { facts: opts.facts ?? LANE_FACTS };
    const merge = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
    const authorize = vi.fn(() => null);
    const exec = new MoaMergeExecutor({
      effects,
      facts: { readFresh: async () => state.facts },
      merge,
      laneContext: async () => { throw new Error('the Moa lane context is never used for a lane effect'); },
      authorize,
      ...(opts.wired === false ? {} : {
        lane: {
          inputs: () => (opts.inputs === undefined ? { factoryEnabled: true, killSwitch: false, dailyCap: 5 } : opts.inputs),
          laneContext: async () => ({
            trustedAuthors: ['owner'], askerBranches: [state.facts.headRefName], verdicts: opts.verdicts ?? [BOT_PASS],
            authorWorkspaces: ['ws-author'], botVerdictsOnly: true, evidenceRows: new Map([[ROW.taskId, ROW]]),
          }),
        },
      }),
      ...(opts.updateBranch ? { updateBranch: opts.updateBranch } : {}),
    });
    return { effects, exec, merge, authorize, state };
  }
  const enqueue = (effects: MoaEffectStore, prNumber = 7, repoKey = 'github.com/o/r') =>
    effects.enqueueLane({ repoKey, repoPath: '/r', prNumber, expectHead: HEAD });

  it('the same head twice is one effect', async () => {
    const { effects } = await laneSetup();
    const [a, b] = await Promise.all([enqueue(effects), enqueue(effects)]);
    const c = await enqueue(effects);
    expect(a.id).toBe(`lane:github.com/o/r#7:${HEAD}`);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(effects.list()).toHaveLength(1);
    expect(a).toMatchObject({ approvedBy: 'lane', status: 'pending' });
    expect(a.decisionId).toBeUndefined();
  });

  it('merges with a bot PASS backed by evidence, through the lane authorize (never the Moa one)', async () => {
    const { effects, exec, merge, authorize } = await laneSetup();
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'done' });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('without a verifier PASS it is refused', async () => {
    const { effects, exec, merge } = await laneSetup({ verdicts: [] });
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:no-verdict' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('a pane PASS without evidence is refused', async () => {
    const pane: PrVerdictRecord = { ...BOT_PASS, version: 1, principal: { workspaceId: 'ws-verifier', ptyId: 'pty-v', agent: 'claude' }, evidence: undefined };
    const { effects, exec, merge } = await laneSetup({ verdicts: [pane] });
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdict-no-evidence' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('unwired, the factory off, the kill switch on, or the cap reached: refused before any read', async () => {
    const cases: Array<[Parameters<typeof laneSetup>[0], string]> = [
      [{ wired: false }, 'lane-not-wired'],
      [{ inputs: null }, 'lane-inputs-unreadable'],
      [{ inputs: { factoryEnabled: false, killSwitch: false, dailyCap: 5 } }, 'factory-disabled'],
      [{ inputs: { factoryEnabled: true, killSwitch: true, dailyCap: 5 } }, 'lane-paused'],
      [{ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 0 } }, 'lane-daily-cap'],
    ];
    for (const [opts, reason] of cases) {
      fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
      const { effects, exec, merge } = await laneSetup(opts);
      const e = await enqueue(effects);
      expect(await exec.run(e.id), reason).toMatchObject({ status: 'refused', reason });
      expect(merge).not.toHaveBeenCalled();
    }
  });

  it('the daily cap counts lane merges done today', async () => {
    const { effects, exec, merge } = await laneSetup({ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 1 } });
    const first = await enqueue(effects, 7);
    expect(await exec.run(first.id)).toMatchObject({ status: 'done' });
    const second = await enqueue(effects, 8);
    expect(await exec.run(second.id)).toMatchObject({ status: 'refused', reason: 'lane-daily-cap' });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  describe('update-branch (R9)', () => {
    const BEHIND: PrLaneFacts = { ...LANE_FACTS, mergeStateStatus: 'BEHIND' };

    it('a BEHIND same-repo wtask/* branch is updated, not merged, and the try ends behind-updated', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
      const { effects, exec, merge } = await laneSetup({ facts: BEHIND, updateBranch });
      const e = await enqueue(effects);
      expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'behind-updated' });
      expect(updateBranch).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }));
      expect(merge).not.toHaveBeenCalled();
    });

    it('a failed update ends refused with its reason', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: false, code: 'moved', message: 'moved' }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, updateBranch });
      expect(await exec.run((await enqueue(effects)).id)).toMatchObject({ status: 'refused', reason: 'head-moved' });
      fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
      const throws = await laneSetup({ facts: BEHIND, updateBranch: async () => { throw new Error('boom'); } });
      expect(await throws.exec.run((await enqueue(throws.effects)).id)).toMatchObject({ status: 'refused', reason: 'behind-update-error' });
    });

    it('never for a fork or a branch fan-out did not make', async () => {
      for (const facts of [{ ...BEHIND, isCrossRepository: true }, { ...BEHIND, headRefName: 'feat/x' }]) {
        fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
        const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
        const { effects, exec, merge } = await laneSetup({ facts, updateBranch });
        await exec.run((await enqueue(effects)).id);
        expect(updateBranch).not.toHaveBeenCalled();
        expect(merge).toHaveBeenCalledTimes(facts.isCrossRepository ? 0 : 1);
      }
    });

    it('never when the lane predicates fail', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, verdicts: [], updateBranch });
      expect(await exec.run((await enqueue(effects)).id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:no-verdict' });
      expect(updateBranch).not.toHaveBeenCalled();
    });

    it('never for owner or moa-auto effects', async () => {
      for (const approvedBy of ['owner', 'moa-auto'] as const) {
        fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
        const { e, exec, merge } = await setup({ ok: false, code: 'blocked', reason: 'behind', message: 'behind' } as PrWriteResult, approvedBy, { ...FACTS, headRefName: 'wtask/x', mergeStateStatus: 'BEHIND' });
        const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
        const ports = (exec as unknown as { ports: MoaMergeExecutorPorts }).ports;
        const base = ports.laneContext;
        ports.updateBranch = updateBranch;
        ports.laneContext = async (eff, f) => ({ ...(await base(eff, f)), askerBranches: ['wtask/x'] });
        expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'blocked-behind' });
        expect(updateBranch).not.toHaveBeenCalled();
        expect(merge).toHaveBeenCalledTimes(1);
      }
    });

    it('one update per repo at a time', async () => {
      let live = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => releases.push(r));
        live -= 1;
        return { ok: true };
      });
      const verdicts = [7, 8, 9].map((prNumber) => ({ ...BOT_PASS, prNumber }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, updateBranch, verdicts });
      const a = await enqueue(effects, 7);
      const b = await enqueue(effects, 8);
      const c = await enqueue(effects, 9, 'github.com/o/other');
      // Each PR reads as its own number.
      (exec as unknown as { ports: MoaMergeExecutorPorts }).ports.facts = { readFresh: async (_p, _k, n) => ({ ...BEHIND, number: n }) };
      const runs = [a, b, c].map((e) => exec.run(e.id));
      await vi.waitFor(() => expect(updateBranch).toHaveBeenCalledTimes(2));
      expect(peak).toBe(2); // o/r and o/other in parallel, never two on o/r
      while (updateBranch.mock.calls.length < 3 || releases.length > 0) {
        releases.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      }
      const done = await Promise.all(runs);
      expect(done.map((r) => r?.reason)).toEqual(['behind-updated', 'behind-updated', 'behind-updated']);
      const repos = updateBranch.mock.calls.map((call) => (call as unknown as [MergeEffect])[0].repoKey);
      expect(repos.filter((k) => k === 'github.com/o/r')).toHaveLength(2);
    });
  });
});
