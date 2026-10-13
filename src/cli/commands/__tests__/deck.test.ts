import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The prune cases check what `wmux deck` reports and which records survive, not
// crash durability. The Deck stores write with `durable: true`; on
// windows-latest each fsync+rename cost 100-800 ms in the CI timeline, and a
// prune case ran past 5 s. Same writes, same files and format, minus the fsync.
vi.mock('../../../daemon/util/atomicWrite', async (importOriginal) => {
  const { withoutFsync } = await import('../../../test-utils/nonDurableAtomicWrite');
  return withoutFsync(await importOriginal());
});
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDeck, handleDeck, type DeckDeps, DECK_USAGE } from '../deck';
import {
  beginOrContinueDeckWork,
  loadActiveDeckWork,
  loadArchivedDeckWorks,
  setDeckWorkBootId,
} from '../../../main/deck/deckWorkStore';
import {
  setWorkspaceMode,
  getDeckAutonomyPath,
} from '../../../main/deck/deckAutonomyStore';
import {
  raiseDecision,
  loadWorkspaceDecision,
} from '../../../main/deck/deckDecisionStore';
import type { RpcResponse } from '../../../shared/rpc';
import { reconcileOrphanDeckState } from '../../../main/deck/deckOrphanReconcile';

let dir: string;

function snapshotDir(targetDir: string): Record<string, string> {
  const files = fs.readdirSync(targetDir);
  const snap: Record<string, string> = {};
  for (const f of files) {
    snap[f] = fs.readFileSync(path.join(targetDir, f), 'utf8');
  }
  return snap;
}

function createMockDeps(overrides?: Partial<DeckDeps>): {
  deps: DeckDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];

  const deps: DeckDeps = {
    getWorkspaces: () =>
      Promise.resolve<RpcResponse>({
        id: '1',
        ok: true,
        result: [{ id: 'ws-live', name: 'Live Workspace' }],
      }),
    // Stands in for the running app: the real 'deck.state.prune' handler runs
    // the same reconcile in-process against the live workspace list.
    pruneInApp: async () => {
      const report = await reconcileOrphanDeckState(['ws-live'], { dir, now: Date.now(), dryRun: false, log: () => undefined });
      return { id: '2', ok: true, result: { archived: report.archived, tornDown: report.tornDown ?? [], skipped: report.skippedIds ?? [] } };
    },
    getWmuxDir: () => dir,
    now: () => Date.now(),
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    },
    exit: vi.fn(),
    ...overrides,
  };

  return { deps, logs, errors };
}

async function seedFixture(targetDir: string, oldTimestamp = true) {
  const ts = oldTimestamp ? Date.now() - 100 * 3600 * 1000 : Date.now();

  // 1. deck-work.json: ws-orphan1, ws-orphan2, ws-live
  beginOrContinueDeckWork('ws-orphan1', 'work orphan 1', targetDir, ts);
  beginOrContinueDeckWork('ws-orphan2', 'work orphan 2', targetDir, ts);
  beginOrContinueDeckWork('ws-live', 'work live', targetDir, ts);
  setDeckWorkBootId('boot-fixture');

  // 2. deck-autonomy.json: ws-orphan2, ws-orphan3, ws-live
  await setWorkspaceMode('ws-orphan2', 'danger', targetDir);
  await setWorkspaceMode('ws-orphan3', 'assist', targetDir);
  await setWorkspaceMode('ws-live', 'danger', targetDir);

  // 3. deck-decisions.json: ws-orphan1, ws-live
  await raiseDecision('ws-orphan1', { question: 'q1', options: ['yes', 'no'], context: 'c1' }, targetDir);
  await raiseDecision('ws-live', { question: 'q live', options: ['a', 'b'], context: 'c live' }, targetDir);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-cli-test-'));
  setDeckWorkBootId('initial-boot-id');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('wmux deck CLI', () => {
  describe('no flag -> usage', () => {
    it('prints usage and exits non-zero when run with no arguments', async () => {
      const { deps, errors } = createMockDeps();
      const code = await runDeck([], deps);

      expect(code).toBe(1);
      expect(deps.exit).toHaveBeenCalledWith(1);
      expect(errors.join('\n')).toContain(DECK_USAGE.trimEnd());
    });

    it('prints usage and exits non-zero when run with state command but no flags', async () => {
      const { deps, errors } = createMockDeps();
      const code = await runDeck(['state'], deps);

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(DECK_USAGE.trimEnd());
    });

    it('prints usage and exits non-zero for unknown subcommands', async () => {
      const { deps, errors } = createMockDeps();
      const code = await runDeck(['unknown'], deps);

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(DECK_USAGE.trimEnd());
    });
  });

  describe('unreachable/empty/erroring workspace list -> refusal and no write in both modes', () => {
    it('refuses --orphans when wmux RPC is unreachable', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.reject(new Error('Connection refused')),
      });

      const code = await runDeck(['state', '--orphans'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('refuses --orphans when wmux RPC replies with an error', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.resolve({ id: '1', ok: false, error: 'Internal daemon error' }),
      });

      const code = await runDeck(['state', '--orphans'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('refuses --orphans when wmux RPC returns an empty workspace list', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.resolve({ id: '1', ok: true, result: [] }),
      });

      const code = await runDeck(['state', '--orphans'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('refuses --prune --yes when wmux RPC is unreachable', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.reject(new Error('Connection refused')),
      });

      const code = await runDeck(['state', '--prune', '--yes'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('refuses --prune --yes when wmux RPC replies with an error', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.resolve({ id: '1', ok: false, error: 'Daemon timeout' }),
      });

      const code = await runDeck(['state', '--prune', '--yes'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('refuses --prune --yes when wmux RPC returns an empty workspace list', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps({
        getWorkspaces: () => Promise.resolve({ id: '1', ok: true, result: [] }),
      });

      const code = await runDeck(['state', '--prune', '--yes'], deps);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state: cannot read the live workspace list (is wmux running?)');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });
  });

  describe('--orphans', () => {
    it('lists orphans with the files they appear in and writes nothing', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, logs } = createMockDeps();
      const code = await runDeck(['state', '--orphans'], deps);

      expect(code).toBe(0);
      const output = logs.join('\n');
      expect(output).toContain('ws-orphan1: deck-decisions.json, deck-work.json');
      expect(output).toContain('ws-orphan2: deck-autonomy.json, deck-work.json');
      expect(output).toContain('ws-orphan3: deck-autonomy.json');
      expect(output).toContain('orphans: 3');

      // Crucial: no file changed
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('supports --json mode and writes nothing', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, logs } = createMockDeps();
      const code = await runDeck(['state', '--orphans', '--json'], deps);

      expect(code).toBe(0);
      const json = JSON.parse(logs.join('\n'));
      expect(json.orphans).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);
      expect(json.count).toBe(3);
      expect(json.files['ws-orphan1']).toEqual(['deck-decisions.json', 'deck-work.json']);
      expect(json.files['ws-orphan2']).toEqual(['deck-autonomy.json', 'deck-work.json']);
      expect(json.files['ws-orphan3']).toEqual(['deck-autonomy.json']);

      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('prints orphans: 0 and exits 0 when no orphans exist', async () => {
      // Seed only live workspace
      beginOrContinueDeckWork('ws-live', 'live work', dir);
      await setWorkspaceMode('ws-live', 'danger', dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, logs } = createMockDeps();
      const code = await runDeck(['state', '--orphans'], deps);

      expect(code).toBe(0);
      expect(logs.join('\n').trim()).toBe('orphans: 0');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });
  });

  describe('--prune', () => {
    it('refuses without --yes and writes nothing', async () => {
      await seedFixture(dir);
      const beforeSnap = snapshotDir(dir);

      const { deps, errors } = createMockDeps();
      const code = await runDeck(['state', '--prune'], deps);

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('deck state --prune requires --yes');
      expect(snapshotDir(dir)).toEqual(beforeSnap);
    });

    it('removes orphans, keeps live workspace, and archives orphan work records with --yes', async () => {
      await seedFixture(dir);

      const { deps, logs } = createMockDeps();
      const code = await runDeck(['state', '--prune', '--yes'], deps);

      expect(code).toBe(0);
      const output = logs.join('\n');
      expect(output).toContain('archived: ws-orphan1, ws-orphan2');
      expect(output).toContain('archive:');
      expect(output).toContain('deck-work.archive.json');
      expect(output).toContain('torn down: ws-orphan1, ws-orphan2, ws-orphan3');
      expect(output).toContain('orphans: 0');

      // Check all 3 files: only ws-live remains!
      // 1. Work store
      expect(loadActiveDeckWork('ws-orphan1', dir)).toBeNull();
      expect(loadActiveDeckWork('ws-orphan2', dir)).toBeNull();
      expect(loadActiveDeckWork('ws-live', dir)).not.toBeNull();

      // Check archived records
      const archived = loadArchivedDeckWorks(dir);
      expect(archived).toHaveLength(2);
      expect(archived.map((w) => w.workspaceId).sort()).toEqual(['ws-orphan1', 'ws-orphan2']);

      // 2. Autonomy
      const rawAutonomy = JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'));
      expect('ws-orphan2' in rawAutonomy).toBe(false);
      expect('ws-orphan3' in rawAutonomy).toBe(false);
      expect('ws-live' in rawAutonomy).toBe(true);

      // 3. Decision
      expect(loadWorkspaceDecision('ws-orphan1', dir)).toBeNull();
      expect(loadWorkspaceDecision('ws-live', dir)).not.toBeNull();
    });

    it('reports parked work younger than TTL as skipped when re-listing orphans', async () => {
      // ws-young parked 5 hours ago (< 72h TTL)
      const now = Date.now();
      const youngTs = now - 5 * 3600 * 1000;
      beginOrContinueDeckWork('ws-young', 'young parked work', dir, youngTs);
      setDeckWorkBootId('fresh-boot-id');

      const { deps, logs } = createMockDeps({
        now: () => now,
      });

      const code = await runDeck(['state', '--prune', '--yes'], deps);
      expect(code).toBe(0);
      const output = logs.join('\n');

      expect(output).toContain('ws-young: deck-work.json (skipped: parked work younger than TTL)');
      expect(output).toContain('orphans: 1');

      // ws-young must still exist in active work, NOT archived
      expect(loadActiveDeckWork('ws-young', dir)).not.toBeNull();
      expect(loadArchivedDeckWorks(dir)).toHaveLength(0);
    });

    it('supports --json mode on --prune --yes', async () => {
      await seedFixture(dir);

      const { deps, logs } = createMockDeps();
      const code = await runDeck(['state', '--prune', '--yes', '--json'], deps);

      expect(code).toBe(0);
      const json = JSON.parse(logs.join('\n'));
      expect(json.archived.sort()).toEqual(['ws-orphan1', 'ws-orphan2']);
      expect(json.tornDown.sort()).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);
      expect(json.archive).toContain('deck-work.archive.json');
      expect(json.orphans).toEqual([]);
      expect(json.count).toBe(0);
    });
  });

  describe('handleDeck', () => {
    it('delegates to runDeck using overrides bundle', async () => {
      await seedFixture(dir);
      const logs: string[] = [];

      await handleDeck(['state', '--orphans'], {
        getWorkspaces: () =>
          Promise.resolve({
            id: '1',
            ok: true,
            result: [{ id: 'ws-live', name: 'Live' }],
          }),
        getWmuxDir: () => dir,
        now: () => Date.now(),
        console: {
          log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
          error: vi.fn(),
        },
        exit: vi.fn(),
      });

      expect(logs.join('\n')).toContain('orphans: 3');
    });
  });
});

describe('wmux deck state --prune runs in the app', () => {
  it('never rewrites Deck files itself and reports the app refusal', async () => {
    const pruneInApp = vi.fn(async (): Promise<RpcResponse> => ({ id: '9', ok: false, error: 'deck.state.prune: the saved session was not restored' }));
    const { deps, errors } = createMockDeps({ pruneInApp });
    const code = await runDeck(['state', '--prune', '--yes'], deps);
    expect(pruneInApp).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('saved session was not restored');
  });
});
