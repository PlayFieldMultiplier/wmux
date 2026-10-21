// The merge lane host: nothing is enqueued before CI is green and a PASS
// exists at the head; only bot-task PRs are the lane's; a repro PR and any
// failing predicate become merge.refused; auto-merge off posts a ready card,
// on enqueues one lane effect and runs it once; the lane's gate inputs and
// identity check; executor outcomes as facts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile } from '../../../shared/bot';
import type { Fact, FactDraft } from '../../../shared/facts';
import type { LedgerEntry } from '../../../shared/ledger';
import type { MergeEffect } from '../../../shared/moaDecision';
import type { PrLaneFacts } from '../../../shared/prReview';
import type { PrVerdictRecord } from '../../../shared/prVerdict';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../../../shared/factorySettings';
import { LANE_REFUSAL_HOLD_MS, LANE_REFUSAL_POLL_MS, MergeLaneHost, botRowsOnRepo, evidenceRowOf, fileLaneLogins, memoryLaneLogins, type LaneHostPorts } from '../mergeLaneHost';
import { MoaEffectStore } from '../../deck/moaEffectStore';
import { RoomWriter } from '../roomWriter';
import { defaultTriggers } from '../roleDefaults';
import { WakeTaint, runningWakeTainted, setWakeTaint } from '../wakeTaint';
import { WakeQueue, wakeQueuePath } from '../wakeQueue';
import { handleRoomRead } from '../../pipe/handlers/room.rpc';
import type { Handoff } from '../../../shared/handoff';
import type { WakeItem } from '../../../shared/wake';

const KEY = 'github.com/o/r';
const HEAD = 'b'.repeat(40);
const BRANCH = 'wtask/fix-login-ab12cd34';

const FACTS: PrLaneFacts = {
  number: 3, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: BRANCH, baseRefName: 'main',
  author: 'owner', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
};

const verifier: BotProfile = {
  version: 1, id: 'bot-0000000v', workspaceId: 'ws-1', role: 'verifier', name: 'Verifier', engine: { kind: 'claude-sdk' },
  triggers: defaultTriggers('verifier'), budget: { maxTurnsPerHour: 9, maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
};

const leadTask: LedgerEntry = {
  schemaVersion: 1, id: 'wtask-lead', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-1', title: 'fix login', status: 'review_requested',
  rev: 2, updatedAt: 1, updatedBy: { kind: 'worker', workspaceId: 'ws-task' }, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000l', tainted: false }, preset: 'default' },
};
const verifyTask: LedgerEntry = {
  schemaVersion: 1, id: 'wtask-verify', taskWorkspaceId: 'ws-v', ownerWorkspaceId: 'ws-1', title: 'verify #3', status: 'review_requested',
  rev: 2, updatedAt: 1, updatedBy: { kind: 'worker', workspaceId: 'ws-v' },
  dispatch: { origin: { kind: 'bot', botId: verifier.id }, preset: 'verify', checkout: { sha: HEAD, detached: true } },
  gate: { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system', headSha: HEAD },
};
const PASS: PrVerdictRecord = {
  version: 2, repoKey: KEY, prNumber: 3, headSha: HEAD, verdict: 'pass', principal: { workspaceId: 'ws-1', botId: verifier.id, agent: 'claude' },
  evidence: { taskId: verifyTask.id, gateHeadSha: HEAD }, summary: 'gate green', at: 1,
};

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-lane-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

type RigOptions = Omit<Partial<LaneHostPorts>, 'settings' | 'verdicts'> & { settings?: Partial<FactorySettings>; ci?: boolean; verdicts?: PrVerdictRecord[]; facts?: PrLaneFacts; tasks?: LedgerEntry[] };

function rig(opts: RigOptions = {}) {
  const { settings: settingsOver, ci, verdicts, facts, tasks, ...over } = opts;
  const settings: FactorySettings = { ...DEFAULT_FACTORY_SETTINGS, enabled: true, trustedAuthors: [], ...settingsOver };
  const effects = new MoaEffectStore(dir);
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const appended: FactDraft[] = [];
  let seq = 0;
  const keys = new Set<string>();
  const appendFact = (d: FactDraft): Fact | null => {
    const key = `${d.kind}:${d.repoKey}#${d.ref?.pr}:${d.ref?.headSha}`;
    if (keys.has(key)) return null;
    keys.add(key);
    appended.push(d);
    seq++;
    return { ...d, id: `f${seq}`, seq, dedupeKey: key } as Fact;
  };
  const run = vi.fn(async (id: string): Promise<MergeEffect | null> => {
    await effects.claim(id);
    return effects.finish(id, 'done');
  });
  const state = { settings, ci: ci ?? true, verdicts: verdicts ?? [PASS], facts: facts ?? FACTS, tasks: tasks ?? [leadTask], login: 'owner' as string | null };
  const ports: LaneHostPorts = {
    settings: () => state.settings,
    bots: () => ({ listEnabled: () => [verifier], get: (id) => (id === verifier.id ? verifier : null) }),
    ciGreen: () => state.ci,
    verdicts: async () => state.verdicts,
    laneFacts: async () => state.facts,
    botTasksOnBranch: async (_repo, branch) => state.tasks.filter(() => branch === BRANCH),
    ledgerRow: (id) => (id === verifyTask.id ? verifyTask : null),
    authorWorkspaces: async () => ['ws-task'],
    ownerLogin: async () => 'owner',
    currentLogin: async () => state.login,
    effects,
    run,
    appendFact,
    rooms: () => writer,
    log: () => undefined,
    ...over,
  };
  return { host: new MergeLaneHost(ports), effects, writer, appended, run, state };
}

const fact = (kind: Fact['kind'], extra: Partial<Fact> = {}): Fact => ({
  id: 'f-x', seq: 1, kind, at: 1, dedupeKey: 'k', repoKey: KEY, ref: { pr: 3, headSha: HEAD }, payload: {}, ...extra,
});

describe('MergeLaneHost', () => {
  it('enqueues nothing until CI is green AND a PASS exists at the head', async () => {
    const noCi = rig({ ci: false, settings: { laneAutoMerge: true } });
    expect(await noCi.host.evaluate(KEY, 3, HEAD)).toBe('waiting-ci');
    const noPass = rig({ verdicts: [{ ...PASS, verdict: 'fail' }], settings: { laneAutoMerge: true } });
    expect(await noPass.host.evaluate(KEY, 3, HEAD)).toBe('waiting-verdict');
    const otherHead = rig({ verdicts: [{ ...PASS, headSha: 'c'.repeat(40) }], settings: { laneAutoMerge: true } });
    expect(await otherHead.host.evaluate(KEY, 3, HEAD)).toBe('waiting-verdict');
    for (const r of [noCi, noPass, otherHead]) {
      expect(r.effects.list()).toEqual([]);
      expect(r.appended).toEqual([]);
    }
  });

  it('does nothing with the factory off, on an unwatched repo, or on a PR no bot task owns', async () => {
    expect(await rig({ settings: { enabled: false } }).host.evaluate(KEY, 3, HEAD)).toBe('off');
    expect(await rig().host.evaluate('github.com/x/y', 3, HEAD)).toBe('not-watched');
    const human = rig({ tasks: [] });
    expect(await human.host.evaluate(KEY, 3, HEAD)).toBe('not-bot-owned');
    expect(human.appended).toEqual([]);
    expect(await rig({ facts: { ...FACTS, headRefOid: 'c'.repeat(40) } }).host.evaluate(KEY, 3, HEAD)).toBe('stale-head');
  });

  it('a PR from a repro worker is the owner\'s: merge.refused repro-origin', async () => {
    const r = rig({ tasks: [{ ...leadTask, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000t' }, preset: 'repro' } }] });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('owner-only');
    expect(r.appended).toMatchObject([{ kind: 'merge.refused', repoKey: KEY, ref: { pr: 3, headSha: HEAD }, payload: { reason: expect.stringContaining('repro-origin') } }]);
  });

  it('a PR a tainted bot task touched is the owner\'s: merge.refused tainted-origin, and a rule may not approve it', async () => {
    const tainted: LedgerEntry = { ...leadTask, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000l', tainted: true }, preset: 'default' } };
    const r = rig({ tasks: [tainted], settings: { laneAutoMerge: true } });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('owner-only');
    expect(r.appended).toMatchObject([{ kind: 'merge.refused', payload: { reason: expect.stringContaining('tainted-origin') } }]);
    expect(r.effects.list()).toEqual([]);
    const req = { repoKey: KEY, repoPath: '/repo', prNumber: 3, headSha: HEAD, tainted: false };
    expect(await r.host.ruleCheck(req)).toBe('tainted-origin');
    const effect = { id: 'lane:x', approvedBy: 'lane', repoKey: KEY, repoPath: '/repo', prNumber: 3, expectHead: HEAD } as MergeEffect;
    expect(await r.host.taintRefusal(effect, FACTS)).toBe('tainted-origin');
    expect(await rig().host.taintRefusal(effect, FACTS)).toBeNull();
    expect(await rig({ botTasksOnBranch: async () => { throw new Error('daemon down'); } }).host.taintRefusal(effect, FACTS)).toBe('tasks-unreadable');
    const repro: LedgerEntry = { ...leadTask, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000t' }, preset: 'repro' } };
    expect(await rig({ tasks: [repro] }).host.taintRefusal(effect, FACTS)).toBe('repro-origin');
  });

  it('ruleCheck: lane-grade predicates and the lane gate, on a fresh read at the request head', async () => {
    const req = { repoKey: KEY, repoPath: '/repo', prNumber: 3, headSha: HEAD, tainted: false };
    expect(await rig({ settings: { laneAutoMerge: true } }).host.ruleCheck(req)).toBeNull();
    // A rule is the owner's consent: lane auto-merge off does not hold it;
    // the factory switch and the daily cap do.
    expect(await rig().host.ruleCheck(req)).toBeNull();
    expect(await rig({ settings: { enabled: false } }).host.ruleCheck(req)).toBe('factory-disabled');
    expect(await rig({ settings: { laneAutoMerge: true, laneDailyCap: 1 }, laneMergesToday: () => 1 }).host.ruleCheck(req)).toBe('lane-daily-cap');
    expect(await rig({ settings: { laneAutoMerge: true } }).host.ruleCheck({ ...req, tainted: true })).toBe('tainted-origin');
    expect(await rig({ settings: { laneAutoMerge: true }, facts: { ...FACTS, headRefOid: 'c'.repeat(40) } }).host.ruleCheck(req)).toBe('head-moved');
    expect(await rig({ settings: { laneAutoMerge: true }, verdicts: [] }).host.ruleCheck(req)).toBe('verifier-pass-at-head:no-verdict');
    expect(await rig({ settings: { laneAutoMerge: true }, facts: { ...FACTS, author: 'stranger' }, ownerLogin: async () => null }).host.ruleCheck(req)).toContain('author-trusted:external-author');
  });

  it('a reading-only PASS taken at an older base tip: the gate is read again at the forge\'s tip, and only then', async () => {
    const BASE = 'd'.repeat(40);
    const NEW = 'e'.repeat(40);
    const reading: PrVerdictRecord = { ...PASS, evidence: { taskId: 'reading-only', gateHeadSha: HEAD, reading: 'no-gate', baseRef: 'origin/main', baseSha: BASE } };
    const reads: Array<[string, string]> = [];
    const at = (tip: string, kind: 'none' | 'declared') => rig({
      verdicts: [reading], facts: { ...FACTS, baseRefOid: tip },
      baseGate: async (repo, sha) => { reads.push([repo, sha]); return kind === 'none' ? { kind: 'none' } : { kind: 'declared', command: 'npm test' }; },
    });
    const settings = { ...DEFAULT_FACTORY_SETTINGS, enabled: true };
    const req = { repoKey: KEY, repoPath: '/repo', prNumber: 3, headSha: HEAD, tainted: false };
    // Unmoved: nothing is read again.
    expect((await at(BASE, 'declared').host.laneContext(KEY, '/repo', { ...FACTS, baseRefOid: BASE }, [reading], [leadTask], settings)).noGateBase).toBeNull();
    expect(reads).toEqual([]);
    // Moved, still no gate at the new tip: it counts.
    expect((await at(NEW, 'none').host.laneContext(KEY, '/repo', { ...FACTS, baseRefOid: NEW }, [reading], [leadTask], settings)).noGateBase).toBe(NEW);
    expect(reads).toEqual([['/repo', NEW]]);
    expect(await at(NEW, 'none').host.ruleCheck(req)).toBeNull();
    // Moved, and the new tip declares a gate: refused.
    expect(await at(NEW, 'declared').host.ruleCheck(req)).toBe('verifier-pass-at-head:base-moved');
  });

  it('authorBots counts every bot whose worker has the head branch, on any repository', async () => {
    const r = rig({ authorBotsOnBranch: async () => [verifier.id] });
    const ctx = await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [leadTask], { ...DEFAULT_FACTORY_SETTINGS, enabled: true });
    expect(ctx.authorBots).toEqual(['bot-0000000l', verifier.id]);
    const unreadable = rig({ authorBotsOnBranch: async () => { throw new Error('daemon down'); } });
    const ctx2 = await unreadable.host.laneContext(KEY, '/repo', FACTS, [PASS], [leadTask], { ...DEFAULT_FACTORY_SETTINGS, enabled: true });
    expect(ctx2.verdicts).toBeNull();
    // A PASS from a bot whose worker wrote the branch does not count, for the lane or a rule.
    const req = { repoKey: KEY, repoPath: '/repo', prNumber: 3, headSha: HEAD, tainted: false };
    const selfPass = { ...PASS, principal: { ...PASS.principal, botId: 'bot-0000000l' } };
    expect(await rig({ settings: { laneAutoMerge: true }, verdicts: [selfPass] }).host.ruleCheck(req)).toBe('verifier-pass-at-head:self-verified');
    expect(await rig({ settings: { laneAutoMerge: true }, authorBotsOnBranch: async () => [verifier.id] }).host.ruleCheck(req)).toBe('verifier-pass-at-head:self-verified');
  });

  it('a failing predicate is merge.refused with every reason; a later different refusal of the head is a card', async () => {
    const r = rig({ settings: { laneAutoMerge: true }, facts: { ...FACTS, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: false }] } });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(r.appended).toMatchObject([{ kind: 'merge.refused', payload: { approvedBy: 'lane', reason: 'required-checks-green:no-required-checks' } }]);
    r.state.facts = { ...r.state.facts, labels: ['needs-windows-verify'] };
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(r.appended).toHaveLength(1);
    expect(r.writer.read('ws-1').cards).toMatchObject([{ kind: 'refusal', threadId: `pr:${KEY}#3`, body: expect.stringContaining('needs-windows-verify') }]);
  });

  it('a verifier in the same workspace as the lead that dispatched the PR worker is not self-verified; the dispatching bot is', async () => {
    const shared = rig({ authorWorkspaces: async () => ['ws-1', 'ws-task'] });
    expect(await shared.host.evaluate(KEY, 3, HEAD)).toBe('ready');
    const self = rig({ tasks: [{ ...leadTask, dispatch: { origin: { kind: 'bot', botId: verifier.id, tainted: false }, preset: 'default' } }] });
    expect(await self.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(String(self.appended[0].payload.reason)).toContain('verifier-pass-at-head:self-verified');
  });

  it('a PASS whose evidence is not a bot verify task does not count while the factory is on', async () => {
    const r = rig({ verdicts: [{ ...PASS, evidence: { taskId: 'wtask-lead', gateHeadSha: HEAD } }] });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(String(r.appended[0].payload.reason)).toContain('verifier-pass-at-head:evidence-mismatch');
  });

  it('auto-merge off: a ready card in the PR thread, once per head; nothing enqueued', async () => {
    const r = rig();
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('ready');
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('ready');
    const cards = r.writer.read('ws-1').cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'status', threadId: `pr:${KEY}#3`, title: expect.stringContaining('Ready to merge #3') });
    expect(r.effects.list()).toEqual([]);
    expect(r.run).not.toHaveBeenCalled();
  });

  it('auto-merge on: one lane effect for the head, run once, even when the CI and verdict facts land together', async () => {
    const r = rig({ settings: { laneAutoMerge: true } });
    const [a, b] = await Promise.all([r.host.onFact(fact('ci.green')), r.host.onFact(fact('verdict.recorded', { payload: { verdict: 'pass' } }))]);
    expect([a, b].sort()).toEqual(['enqueued', 'settled']);
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.effects.list()).toMatchObject([{ id: `lane:${KEY}#3:${HEAD}`, approvedBy: 'lane', status: 'done' }]);
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('settled');
    expect(r.run).toHaveBeenCalledTimes(1);
  });

  it('ignores a FAIL verdict fact and facts without a head', () => {
    const r = rig();
    expect(r.host.onFact(fact('verdict.recorded', { payload: { verdict: 'fail' } }))).toBeNull();
    expect(r.host.onFact(fact('ci.green', { ref: { pr: 3 } }))).toBeNull();
    expect(r.host.onFact(fact('task.done'))).toBeNull();
  });

  it('the gate: factory on, auto-merge as the kill switch, the daily cap', () => {
    expect(rig({ settings: { laneAutoMerge: false, laneDailyCap: 2 } }).host.inputs()).toEqual({ factoryEnabled: true, killSwitch: true, dailyCap: 2 });
    expect(rig({ settings: { laneAutoMerge: true } }).host.inputs()).toEqual({ factoryEnabled: true, killSwitch: false, dailyCap: 5 });
  });

  it('identity: the gh login must be readable and the one kept with the effect; the switches are read again', async () => {
    const logins = memoryLaneLogins();
    const r = rig({ settings: { laneAutoMerge: true }, run: async () => null, logins });
    await r.host.evaluate(KEY, 3, HEAD);
    const effect = r.effects.list()[0];
    expect(logins.get(effect.id)).toBe('owner');
    expect(await r.host.identity(effect)).toBeNull();
    r.state.login = 'someone-else';
    expect(await r.host.identity(effect)).toBe('identity-changed');
    r.state.login = null;
    expect(await r.host.identity(effect)).toBe('identity-unknown');
    // After a restart with no kept login: refused, never the account now signed in.
    r.state.login = 'owner';
    const fresh = rig({ settings: { laneAutoMerge: true }, logins: memoryLaneLogins() });
    expect(await fresh.host.identity(effect)).toBe('identity-unknown');
    // Switched off between the claim and the merge.
    r.state.settings = { ...r.state.settings, laneAutoMerge: false };
    expect(await r.host.identity(effect)).toBe('lane-paused');
    r.state.settings = { ...r.state.settings, enabled: false };
    expect(await r.host.identity(effect)).toBe('factory-disabled');
  });

  it('an unreadable gh login enqueues nothing (the head keeps its one effect)', async () => {
    const r = rig({ settings: { laneAutoMerge: true } });
    r.state.login = null;
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('read-failed');
    expect(r.effects.list()).toEqual([]);
  });

  it('kept logins survive a restart on disk', () => {
    const file = path.join(dir, 'factory', 'lane-logins.json');
    const a = fileLaneLogins(file);
    a.set('lane:x', 'owner');
    expect(fileLaneLogins(file).get('lane:x')).toBe('owner');
    a.delete('lane:x');
    expect(fileLaneLogins(file).get('lane:x')).toBeNull();
  });

  it('the lane context always requires bot evidence, and a task counts only on its bot\'s repository', async () => {
    const r = rig();
    const ctx = await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [leadTask], { ...r.state.settings, enabled: false });
    expect(ctx.botVerdictsOnly).toBe(true);
    const bots = { get: (id: string) => (id === 'bot-0000000l' ? { ...verifier, id, repo: { repoKey: 'o/r', repoPath: '/repo' } } : id === 'bot-other000' ? { ...verifier, id, repo: { repoKey: 'o/other', repoPath: '/o' } } : null) };
    const other = { ...leadTask, id: 'wtask-other', dispatch: { origin: { kind: 'bot', botId: 'bot-other000' }, preset: 'default' } };
    const gone = { ...leadTask, id: 'wtask-gone', dispatch: { origin: { kind: 'bot', botId: 'bot-gone0000' }, preset: 'default' } };
    const human = { ...leadTask, id: 'wtask-human', dispatch: { origin: { kind: 'pane' } } };
    expect(botRowsOnRepo([leadTask, other, gone, human], KEY, bots).map((e) => e.id)).toEqual(['wtask-lead']);
    expect(botRowsOnRepo([leadTask], KEY, null)).toEqual([]);
  });

  it('executor outcomes become merge.done / merge.refused; decision effects are not the lane\'s', () => {
    const r = rig();
    const base: MergeEffect = { id: `lane:${KEY}#3:${HEAD}`, kind: 'pr.merge', repoKey: KEY, repoPath: '/repo', prNumber: 3, expectHead: HEAD, approvedBy: 'lane', status: 'done', attempt: 1, createdAt: 1, updatedAt: 2 };
    r.host.onEffect(base);
    r.host.onEffect({ ...base, status: 'inFlight' });
    r.host.onEffect({ ...base, approvedBy: 'owner', decisionId: 'moa-d-x', status: 'refused' });
    expect(r.appended.map((d) => d.kind)).toEqual(['merge.done']);
    r.host.onEffect({ ...base, status: 'refused', reason: 'lane-daily-cap' });
    expect(r.appended.map((d) => d.kind)).toEqual(['merge.done', 'merge.refused']);
  });

  it('the owner\'s own login is a trusted author only for a head a bot task produced, read when the head is evaluated', async () => {
    // No trusted authors in settings: the owner's login, read now, is what
    // trusts the bot task's PR (a bot added after start included).
    let reads = 0;
    const r = rig({ ownerLogin: async () => { reads++; return 'owner'; } });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('ready');
    expect(reads).toBe(1);
    // Another author stays external.
    const other = rig({ facts: { ...FACTS, author: 'someone' } });
    expect(await other.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(String(other.appended[0].payload.reason)).toContain('author-trusted:external-author');
    // An unreadable login (null or a throw) trusts nobody extra.
    for (const ownerLogin of [async () => null, async () => { throw new Error('gh down'); }]) {
      const unread = rig({ ownerLogin });
      expect(await unread.host.evaluate(KEY, 3, HEAD)).toBe('refused');
      expect(String(unread.appended[0].payload.reason)).toContain('author-trusted:external-author');
    }
    // A head no bot task produced (an executor read that found no task), or
    // a repro worker's, never gets the owner's login.
    expect((await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [], r.state.settings)).trustedAuthors).toEqual([]);
    const repro = { ...leadTask, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000t' }, preset: 'repro' } };
    expect((await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [repro], r.state.settings)).trustedAuthors).toEqual([]);
    const pane = { ...leadTask, dispatch: { origin: { kind: 'pane' } } } as LedgerEntry;
    expect((await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [pane], r.state.settings)).trustedAuthors).toEqual([]);
    const noTask = rig({ tasks: [] });
    const ctx = await noTask.host.effectContext({ id: `lane:${KEY}#3:${HEAD}`, kind: 'pr.merge', repoKey: KEY, repoPath: '/repo', prNumber: 3, expectHead: HEAD, approvedBy: 'lane', status: 'inFlight', attempt: 1, createdAt: 1, updatedAt: 1 }, FACTS);
    expect(ctx.trustedAuthors).toEqual([]);
    // The settings' list stays trusted whatever produced the head.
    expect((await r.host.laneContext(KEY, '/repo', FACTS, [PASS], [], { ...r.state.settings, trustedAuthors: ['Octo'] })).trustedAuthors).toEqual(['octo']);
    // On a GitLab repo a plain entry is a GitHub login: only `host/username` entries of its host count.
    const gl = { ...r.state.settings, trustedAuthors: ['Octo', 'gitlab.example.com/Carol', 'other.example.com/dave'] };
    expect((await r.host.laneContext('gitlab.example.com/group/app', '/repo', FACTS, [PASS], [], gl)).trustedAuthors).toEqual(['carol']);
  });

  it('a refusal card names each reason in plain words, never the raw code', async () => {
    const r = rig({ settings: { laneAutoMerge: true }, facts: { ...FACTS, files: [], author: 'someone', checks: [] } });
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    // The fact keeps the raw codes for the bots.
    expect(r.appended[0].payload.reason).toBe('required-checks-green:no-required-checks, not-release-pr:no-files, gate-definition-changed:no-files, author-trusted:external-author');
    // A different refusal of the same head is a card only: its body is the owner's.
    r.state.facts = { ...r.state.facts, isCrossRepository: true };
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    const body = r.writer.read('ws-1').cards[0].body ?? '';
    expect(body).toContain('- GitHub listed no changed files');
    expect(body).toContain('- The author isn\'t trusted');
    expect(body).toContain('- The repository has no required checks');
    expect(body).toContain('- It comes from a fork');
    expect(body).not.toContain('`');
    expect(body).not.toContain('no-required-checks');
  });

  it('with lane auto-merge off, a PR the owner is asked to approve gets no refusal card; while a bot on the repo is in a turn the card waits for such a request', async () => {
    const asked = new Set<number>();
    let busy = false;
    let clock = 1_000;
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const later = (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    };
    const fire = () => { const t = timers.at(-1)!; clock += t.ms; t.fn(); };
    const failing = { ...FACTS, files: [], checks: [] };
    let rooms = 0;
    const make = () => {
      const writer = new RoomWriter({ dir: path.join(dir, `rooms-${++rooms}`) });
      return { ...rig({ facts: failing, hasApproval: (_k, pr) => asked.has(pr), botsBusy: () => busy, later, now: () => clock, rooms: () => writer }), writer };
    };
    // Asked already: the fact is kept (held from the room), no card, no timer.
    const r = make();
    asked.add(3);
    expect(await r.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(r.appended).toMatchObject([{ kind: 'merge.refused', payload: { cardHeld: true } }]);
    expect(timers).toHaveLength(0);
    expect(r.writer.read('ws-1').cards).toEqual([]);
    asked.clear();
    // Nobody in a turn: the card at once, in plain words.
    const now = make();
    expect(await now.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(timers).toHaveLength(0);
    expect(now.writer.read('ws-1').cards).toMatchObject([{ kind: 'refusal', threadId: `pr:${KEY}#3`, body: expect.stringContaining('GitHub listed no changed files') }]);
    // A bot in a turn: the card waits; the bot asks meanwhile: none.
    busy = true;
    const r2 = make();
    expect(await r2.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(timers.at(-1)!.ms).toBe(LANE_REFUSAL_POLL_MS);
    fire();
    expect(r2.writer.read('ws-1').cards).toEqual([]);
    asked.add(3);
    busy = false;
    fire();
    expect(r2.writer.read('ws-1').cards).toEqual([]);
    asked.clear();
    // The turn ends without a request: the card.
    busy = true;
    const r3 = make();
    expect(await r3.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    busy = false;
    fire();
    expect(r3.writer.read('ws-1').cards).toHaveLength(1);
    // Busy past LANE_REFUSAL_HOLD_MS: the card anyway.
    busy = true;
    const r4 = make();
    expect(await r4.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    clock += LANE_REFUSAL_HOLD_MS;
    fire();
    expect(r4.writer.read('ws-1').cards).toHaveLength(1);
    // The PR merged (or moved on) during the hold: the held card is dropped.
    const r5 = make();
    expect(await r5.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(r5.host.onFact(fact('pr.merged'))).toBeNull();
    expect(timers.at(-1)!.cancelled).toBe(true);
    // A head that moved drops the holds of the old head only.
    const r6 = make();
    expect(await r6.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    r6.host.onFact(fact('pr.head_moved', { ref: { pr: 3, headSha: HEAD } }));
    expect(timers.at(-1)!.cancelled).toBe(false);
    r6.host.onFact(fact('pr.head_moved', { ref: { pr: 3, headSha: 'c'.repeat(40) } }));
    expect(timers.at(-1)!.cancelled).toBe(true);
    // Quit drops a held card.
    const r7 = make();
    expect(await r7.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    expect(timers.at(-1)!.cancelled).toBe(false);
    r7.host.dispose();
    expect(timers.at(-1)!.cancelled).toBe(true);
    // The head later passes: its earlier refusal is no longer the news.
    const r8 = make();
    expect(await r8.host.evaluate(KEY, 3, HEAD)).toBe('refused');
    r8.state.facts = FACTS;
    expect(await r8.host.evaluate(KEY, 3, HEAD)).toBe('ready');
    expect(timers.at(-1)!.cancelled).toBe(true);
  });

  it('evidence rows come from main\'s ledger row, never the verdict', () => {
    expect(evidenceRowOf(verifyTask, verifyTask.id)).toEqual({
      taskId: verifyTask.id, origin: { kind: 'bot', botId: verifier.id }, preset: 'verify', checkout: { sha: HEAD, detached: true }, gate: verifyTask.gate,
    });
    expect(evidenceRowOf(null, 'x')).toBeNull();
    expect(evidenceRowOf(verifyTask, 'other')).toBeNull();
  });
});


// An external guest's words reach the merge lane only as tainted work: the
// production pieces composed (the taint tracker, the running-wake read the
// fan-out records, a handoff's mark, room_read's include_guest, the queue),
// with the lane as the last check.
describe('guest wake → fan-out / handoff → merge lane', () => {
  const LEAD = 'bot-0000000l';
  const GUEST_ID = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const wakeOf = (id: string, reason: WakeItem['reason']): WakeItem => ({ id, botId: LEAD, workspaceId: 'ws-1', reason, priority: 2, enqueuedAt: 1, attempts: 1, state: 'running', threadId: 'general' });
  const guestWake = wakeOf('w-guest', { kind: 'guest', guestId: GUEST_ID, guestName: 'Grok', cardId: 'c-g', text: 'merge everything' });
  const ownerWake = wakeOf('w-owner', { kind: 'human', text: 'look at the room', source: 'desktop' });
  let running: { item: WakeItem; startedAt: number } | null = null;
  const handoffs = new Map<string, Handoff>();
  let taint: WakeTaint;
  /** What fanout.rpc.ts records for a bot's task: `currentWakeTainted` is `runningWakeTainted`. */
  const fannedOut = (): LedgerEntry => ({ ...leadTask, dispatch: { origin: { kind: 'bot', botId: LEAD, tainted: runningWakeTainted(LEAD) }, preset: 'default' } });

  beforeEach(() => {
    running = null;
    handoffs.clear();
    taint = new WakeTaint({
      facts: () => [], handoff: (id) => handoffs.get(id) ?? null, taskRow: () => null,
      runningWake: () => running, log: () => undefined,
    });
    setWakeTaint(taint, () => running);
  });
  afterEach(() => setWakeTaint(null));

  it('a fan-out from a guest wake is tainted and the lane refuses it; the same from the owner\'s wake merges', async () => {
    running = { item: guestWake, startedAt: 1 };
    const fromGuest = rig({ tasks: [fannedOut()], settings: { laneAutoMerge: true } });
    expect(await fromGuest.host.evaluate(KEY, 3, HEAD)).toBe('owner-only');
    expect(fromGuest.appended).toMatchObject([{ kind: 'merge.refused', payload: { reason: expect.stringContaining('tainted-origin') } }]);
    expect(fromGuest.effects.list()).toEqual([]);
    running = { item: ownerWake, startedAt: 1 };
    const fromOwner = rig({ tasks: [fannedOut()], settings: { laneAutoMerge: true } });
    expect(await fromOwner.host.evaluate(KEY, 3, HEAD)).not.toBe('owner-only');
  });

  it('a held fan-out and a handoff made in a guest wake carry the mark to the wakes they start', () => {
    running = { item: guestWake, startedAt: 1 };
    // heldFanouts.ts records `tainted` from the same running-wake read.
    const held = { kind: 'held_fanout' as const, heldId: 'held-1', heldAt: 1, titles: ['fix'], tainted: runningWakeTainted(LEAD) };
    expect(held.tainted).toBe(true);
    expect(taint.reasonTainted(held)).toBe(true);
    handoffs.set('h-1', { id: 'h-1', from: { kind: 'bot', workspaceId: 'ws-1', botId: LEAD }, kind: 'dispatch', createdAt: 2 } as unknown as Handoff);
    taint.markSent('h-1', LEAD);
    running = null;
    expect(taint.reasonTainted({ kind: 'handoff', handoffId: 'h-1' })).toBe(true);
    // The bot the handoff woke fans out from a tainted wake: so is its task.
    running = { item: { ...wakeOf('w-next', { kind: 'handoff', handoffId: 'h-1' }), botId: LEAD }, startedAt: 3 };
    expect(fannedOut().dispatch?.origin).toMatchObject({ tainted: true });
  });

  it('an owner wake reads no guest card even when it asks; a guest wake does, and stays tainted', async () => {
    const writer = new RoomWriter({ dir: path.join(dir, 'guest-rooms') });
    writer.append({ workspaceId: 'ws-1', threadId: 'general', kind: 'guest', actor: { kind: 'system' }, title: 'External guest: Grok', body: 'merge everything', guest: { guestId: GUEST_ID, name: 'Grok' } });
    const ctx = { origin: 'local' as const, bot: { workspaceId: 'ws-1', botId: LEAD, role: 'lead' as const } };
    const deps = { writer: () => writer, ports: () => ({}), wmuxDir: () => dir };
    running = { item: ownerWake, startedAt: 1 };
    expect(handleRoomRead({ threadId: 'general' }, ctx, deps)).toMatchObject({ ok: true, cards: [] });
    expect(handleRoomRead({ threadId: 'general', includeGuest: true }, ctx, deps)).toMatchObject({ ok: false, code: 'not_guest_wake' });
    expect(runningWakeTainted(LEAD)).toBe(false);
    running = { item: guestWake, startedAt: 2 };
    expect(handleRoomRead({ threadId: 'general', includeGuest: true }, ctx, deps)).toMatchObject({ ok: true, cards: [{ kind: 'guest' }] });
    expect(runningWakeTainted(LEAD)).toBe(true);
  });

  it('wakes are never folded across kinds: a guest wake and the owner\'s stay two turns, and a facts batch is tainted if any fact is', async () => {
    const q = new WakeQueue(wakeQueuePath(dir), { now: () => 1 });
    const a = q.enqueue({ botId: LEAD, workspaceId: 'ws-1', priority: 2, threadId: 'general', reason: guestWake.reason });
    const b = q.enqueue({ botId: LEAD, workspaceId: 'ws-1', priority: 0, threadId: 'general', reason: ownerWake.reason });
    expect(a && b && a.id !== b.id).toBe(true);
    expect(q.list({ botId: LEAD }).map((i) => i.reason.kind).sort()).toEqual(['guest', 'human']);
    // The queue's write lands before the folder is removed.
    await q.flush();
    const withFacts = new WakeTaint({
      facts: (ids) => ids.map((id) => ({ id, seq: 1, kind: id === 'f-pr' ? 'pr.opened' : 'merge.done', at: 1, dedupeKey: id, ref: {}, payload: {} })) as never,
      handoff: () => null, taskRow: () => null, runningWake: () => null,
    });
    expect(withFacts.reasonTainted({ kind: 'facts', factIds: ['f-ok', 'f-pr'], trigger: { kind: 'fact' } as never })).toBe(true);
    expect(withFacts.reasonTainted({ kind: 'facts', factIds: ['f-ok'], trigger: { kind: 'fact' } as never })).toBe(false);
  });
});
