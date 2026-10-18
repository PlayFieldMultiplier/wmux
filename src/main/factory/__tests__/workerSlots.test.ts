// Each task's launch generation and its panes, on disk (#2393).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { WORKER_SLOTS_FILENAME, WORKER_SLOTS_VERSION, WorkerSlots, beginPaneRelaunch, setWorkerSlotsForTests, taskOfPane } from '../workerSlots';
import { AGENT_GONE_FILENAME, AgentGoneFacts } from '../agentGoneFacts';
import { rowHoldsAgentSlot, SLOT_ROW_GRACE_MS } from '../agentSlots';
import { FanOutGuards, recordFanoutTaskPane, setFanOutGuardsForTests, stampFanoutTaskPane, taskOfWorkspace } from '../../worktask/fanoutGuards';

const BOT = 'bot-0000000a';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worker-slots-'));

function store(dir: string, opts: { rows?: LedgerEntry[]; now?: () => number; warn?: string[] } = {}): WorkerSlots {
  const s = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => opts.rows ?? [], (l) => opts.warn?.push(l), opts.now ?? Date.now);
  s.load();
  return s;
}

const row = (id: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: 1, id, taskWorkspaceId: `ws-${id}`, ownerWorkspaceId: 'ws-owner', title: id, status: 'working', rev: 4,
  updatedAt: 1_000, updatedBy: { kind: 'worker', workspaceId: `ws-${id}` }, dispatch: { origin: { kind: 'bot', botId: BOT } }, ...over,
});

afterEach(() => {
  setWorkerSlotsForTests(null);
  setFanOutGuardsForTests(null);
});

describe('WorkerSlots', () => {
  it('a restart keeps each task\'s generation and each pane\'s task', () => {
    const dir = tmp();
    const s = store(dir);
    const { gen } = s.beginLaunch({ taskId: 't1', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t1' });
    expect(gen).toBe(1);
    expect(s.launched('t1', gen, 'ws-t1', 'pty-1', '/w/t1')).toBe(true);
    const again = store(dir);
    expect(again.launchOf('t1')).toMatchObject({ taskId: 't1', gen: 1, origin: 'owner', state: 'launched' });
    expect(again.paneOf('pty-1')).toEqual({ taskId: 't1', gen: 1, workspaceId: 'ws-t1' });
  });

  it('a respawn bumps the generation, and a late answer of the older one changes nothing', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    expect(second).toBe(first + 1);
    expect(s.launched('t', first, 'ws-old', 'pty-old')).toBe(false);
    expect(s.released('t', first)).toBe(false);
    expect(s.paneOf('pty-old')).toBeNull();
    expect(s.launchOf('t')).toMatchObject({ gen: second, state: 'launching' });
    expect(s.launched('t', second, 'ws-new', 'pty-new')).toBe(true);
    expect(s.launchOf('t')?.state).toBe('launched');
  });

  it('a pane keeps its task wherever it moves; the pane create reads its launch from the folder', () => {
    const dir = tmp();
    const s = store(dir);
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t' });
    expect(s.inflightFor('ws-owner', '/w/t')).toEqual({ taskId: 't', gen });
    // The pane's create stamps its workspace with the task.
    const guards = new FanOutGuards({ dir, ledgerTaskOwner: () => null, ledgerBotTask: () => null });
    stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', cwd: '/w/t' }, guards, () => s);
    expect(guards.taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
    s.launched('t', gen, 'ws-t', 'pty-t', '/w/t');
    expect(s.inflightFor('ws-owner', '/w/t')).toBeNull();
    // Adopted into another workspace: the pane's own record still names it,
    // and the stamp survives a restart.
    expect(taskOfPane('pty-t')).toEqual({ taskId: 't', gen });
    expect(new FanOutGuards({ dir, ledgerTaskOwner: () => null }).taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
    // A re-mark records a newer generation, never an older one.
    guards.markTask('ws-t', 'ws-owner', undefined, { taskId: 't', gen: gen + 1 });
    guards.markTask('ws-t', 'ws-owner', undefined, { taskId: 't', gen });
    expect(guards.taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen: gen + 1 });
  });

  it('a stamp written before stamps named tasks loads with no task', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'fanout-lineage.json'), JSON.stringify({ version: 1, tasks: { 'ws-old': { owner: 'ws-owner', at: 5 } } }));
    expect(new FanOutGuards({ dir, ledgerTaskOwner: () => null }).taskOfWorkspace('ws-old')).toBeNull();
  });

  it('a launch that cannot be written is refused and leaves nothing behind', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'factory'), 'not a folder');
    const s = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
    s.load();
    expect(() => s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t' })).toThrow(/could not be recorded/);
    expect(s.launchOf('t')).toBeNull();
    expect(s.inflightFor('ws-owner', '/w/t')).toBeNull();
  });

  it('with no file, the entries are rebuilt from the ledger rows and written', () => {
    const dir = tmp();
    const s = store(dir, { rows: [row('open'), row('done', { status: 'completed', dispatch: { origin: { kind: 'pane' } } })] });
    expect(s.launchOf('open')).toMatchObject({ gen: 1, launchedAt: 1_000, origin: 'bot', botId: BOT, state: 'launched' });
    expect(s.launchOf('done')).toMatchObject({ gen: 1, origin: 'owner', state: 'released' });
    expect(fs.existsSync(path.join(dir, 'factory', WORKER_SLOTS_FILENAME))).toBe(true);
    // The next launch of a rebuilt task is its second.
    expect(s.beginLaunch({ taskId: 'open', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen).toBe(2);
  });

  it('a file a newer version wrote is never written over: entries live in memory and launches go on', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: WORKER_SLOTS_VERSION + 1, tasks: [], future: true });
    fs.writeFileSync(file, newer);
    const warn: string[] = [];
    const s = store(dir, { warn, rows: [row('x')] });
    expect(warn.join('\n')).toMatch(/kept in memory only/);
    expect(s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' }).gen).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });

  it('a file no version can read is moved aside, and the entries are rebuilt', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ torn');
    const s = store(dir, { rows: [row('r')], now: () => 42 });
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(`${WORKER_SLOTS_FILENAME}.unreadable-`))).toBe(true);
    expect(s.launchOf('r')?.gen).toBe(1);
    expect(store(dir).launchOf('r')?.gen).toBe(1);
  });
});

describe('round 1 review (#2393 identity)', () => {
  it('a file that can neither be read nor moved aside refuses every launch', () => {
    const dir = tmp();
    const file = path.join(dir, 'factory', WORKER_SLOTS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ torn');
    const rename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = () => { throw new Error('EACCES'); };
    let s: WorkerSlots;
    try {
      s = store(dir);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = rename;
    }
    expect(() => s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' })).toThrow(/could not be recorded/);
  });

  it('a pane\'s create records the pane and its workspace before any renderer reply; a write that fails fails the create', () => {
    const dir = tmp();
    const s = store(dir);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t' });
    recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', cwd: '/w/t' }, 'pty-t', () => s);
    // A crash here: the records are on disk.
    const after = store(dir);
    expect(after.paneOf('pty-t')).toEqual({ taskId: 't', gen, workspaceId: 'ws-t' });
    expect(after.workspaceOf('ws-t')).toEqual({ taskId: 't', gen });
    // A pane no launch is under way for is not recorded.
    recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-x', cwd: '/w/other' }, 'pty-x', () => s);
    expect(s.paneOf('pty-x')).toBeNull();
    const failing = { recordCreate: () => { throw new Error('PTY_CREATE: the task pane could not be recorded: disk full'); } };
    expect(() => recordFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', cwd: '/w/t' }, 'pty-2', () => failing)).toThrow(/could not be recorded/);
  });

  it('a resume in the pane moves its workspace to the new generation too', () => {
    const s = store(tmp());
    const first = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', first, 'ws-t', 'pty-t');
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', second, 'ws-t', 'pty-t');
    expect(s.workspaceOf('ws-t')).toEqual({ taskId: 't', gen: second });
    expect(s.paneOf('pty-t')?.gen).toBe(second);
  });

  it('an older build rewriting the lineage store does not lose a workspace\'s task', () => {
    const dir = tmp();
    const s = store(dir);
    setWorkerSlotsForTests(s);
    const guards = new FanOutGuards({ dir, ledgerTaskOwner: () => null });
    setFanOutGuardsForTests(guards);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t' });
    stampFanoutTaskPane({ fanoutTaskOf: 'ws-owner', workspaceId: 'ws-t', cwd: '/w/t' }, guards, () => s);
    s.launched('t', gen, 'ws-t', 'pty-t', '/w/t');
    // An older build rewrites the stamps without the task fields.
    fs.writeFileSync(path.join(dir, 'fanout-lineage.json'), JSON.stringify({ version: 1, tasks: { 'ws-t': { owner: 'ws-owner', at: 1 } } }));
    setFanOutGuardsForTests(new FanOutGuards({ dir, ledgerTaskOwner: () => null }));
    setWorkerSlotsForTests(store(dir));
    expect(taskOfWorkspace('ws-t')).toEqual({ taskId: 't', gen });
  });

  it('a generation never goes back, even after its entry was dropped', () => {
    const s = store(tmp());
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    s.launched('t', gen, 'ws-t', 'pty-t');
    const second = s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen;
    s.launched('t', second, 'ws-t', 'pty-t');
    // Its entry dropped by the bound (simulated): its pane still names gen 2.
    (s as unknown as { tasks: Map<string, unknown> }).tasks.delete('t');
    expect(s.beginLaunch({ taskId: 't', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' }).gen).toBe(second + 1);
  });
});

describe('round 2 review (#2393 identity)', () => {
  it('a launch line typed into a task\'s pane is its next generation, the pane and workspace named before it is typed', () => {
    const s = store(tmp());
    setWorkerSlotsForTests(s);
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner' });
    s.launched('t', gen, 'ws-t', 'pty-t');
    const settle = beginPaneRelaunch('pty-t');
    expect(s.paneOf('pty-t')?.gen).toBe(gen + 1);
    expect(s.workspaceOf('ws-t')?.gen).toBe(gen + 1);
    settle?.(true);
    expect(s.launchOf('t')).toMatchObject({ gen: gen + 1, state: 'launched', ownerWorkspaceId: 'ws-owner' });
    // A pane no task is known for: nothing to record.
    expect(beginPaneRelaunch('pty-plain')).toBeNull();
  });

  it('a pane created late for a launch that was abandoned is refused', () => {
    const s = store(tmp());
    const { gen } = s.beginLaunch({ taskId: 't', origin: 'owner', ownerWorkspaceId: 'ws-owner', cwd: '/w/t' });
    s.released('t', gen, '/w/t');
    expect(s.inflightFor('ws-owner', '/w/t')).toBeNull();
    expect(() => s.recordCreate('ws-owner', '/w/t', 'ws-late', 'pty-late')).toThrow(/abandoned/);
  });

  it('the rebuild from the ledger names each task\'s workspace', () => {
    const s = store(tmp(), { rows: [row('a')] });
    expect(s.workspaceOf('ws-a')).toEqual({ taskId: 'a', gen: 1 });
  });
});

describe('readers of the recorded launch', () => {
  it('an agent-gone observation that started before the task\'s recorded launch adds no fact, after a restart too', () => {
    const dir = tmp();
    const launchedAt = 5_000;
    const facts = new AgentGoneFacts(path.join(dir, 'factory', AGENT_GONE_FILENAME), () => undefined, () => 9_000, (id) => (id === 't' ? launchedAt : undefined));
    facts.load();
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p'], at: launchedAt - 1 });
    expect(facts.get('t')).toBeNull();
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p'], at: launchedAt + 1 });
    expect(facts.get('t')).not.toBeNull();
  });

  it('a row\'s start-up grace runs from its worker\'s recorded launch, not from the row\'s last edit', () => {
    const now = 100 * 60_000;
    const edited = { ...row('t'), updatedAt: now - 1_000 };
    const live = { workspaces: new Set(['ws-t']), idleWorkspaces: new Set(['ws-t']), now };
    expect(rowHoldsAgentSlot(edited, { ...live, launchedAt: () => now - SLOT_ROW_GRACE_MS - 1 })).toBe(false);
    expect(rowHoldsAgentSlot(edited, { ...live, launchedAt: () => now - 1_000 })).toBe(true);
  });
});
