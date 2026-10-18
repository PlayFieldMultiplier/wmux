// Each task's launch generation and its panes, on disk (#2393).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { WORKER_SLOTS_FILENAME, WORKER_SLOTS_VERSION, WorkerSlots, setWorkerSlotsForTests, taskOfPane } from '../workerSlots';
import { AGENT_GONE_FILENAME, AgentGoneFacts } from '../agentGoneFacts';
import { rowHoldsAgentSlot, SLOT_ROW_GRACE_MS } from '../agentSlots';
import { FanOutGuards, stampFanoutTaskPane } from '../../worktask/fanoutGuards';

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

afterEach(() => setWorkerSlotsForTests(null));

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
