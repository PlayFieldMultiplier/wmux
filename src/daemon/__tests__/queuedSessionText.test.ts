// The approval check, the chat bridge, automation and readSessionText read a
// pane's screen in the shared snapshot queue, and reads of the same pane that
// are still waiting share one parse (#2602). A session id is not a pane's
// identity: a supervised restart re-creates a dead pane under the same id. A
// read must answer for the session it was asked about, never for the one that
// took its id while it waited.
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { enqueueSnapshotJob, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { queuedScreenText, queuedTextSnapshot, type TextReadSession, type TextReadSessions } from '../queuedSessionText';

function session(text: string): TextReadSession {
  const ringBuffer = new RingBuffer(64 * 1024);
  ringBuffer.write(Buffer.from(text));
  return { meta: { cols: 80, rows: 24 }, ringBuffer, bridge: { outputModes: null } };
}

function sessionTable(): TextReadSessions & { map: Map<string, TextReadSession>; lookups: number } {
  const map = new Map<string, TextReadSession>();
  const table = { map, lookups: 0, getSession: (id: string) => { table.lookups++; return map.get(id); } };
  return table;
}

/** Another pane's snapshot holds the queue until `release`. */
function holdQueue(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { release, done: enqueueSnapshotJob(() => held) };
}

function lines(outcome: TextSnapshotOutcome | null): string[] | null {
  if (!outcome) return null;
  if (!outcome.ok) throw new Error(`parse failed: ${outcome.reason}`);
  return outcome.rows.map((r) => r.text.trimEnd()).filter((t) => t.length > 0);
}

describe('queued screen reads', () => {
  it('a read waiting while its pane closes and another session takes the id answers as closed', async () => {
    const sessions = sessionTable();
    sessions.map.set('pane-a', session('old pane screen'));
    sessions.map.set('pane-b', session('closed pane screen'));
    const queue = holdQueue();
    const screen = queuedScreenText(sessions, 'pane-a');
    const undimmed = queuedScreenText(sessions, 'pane-a', true);
    const text = queuedTextSnapshot(sessions, 'pane-a', 100);
    const closed = queuedScreenText(sessions, 'pane-b');

    sessions.map.set('pane-a', session('new pane screen'));
    sessions.map.delete('pane-b');
    queue.release();
    await queue.done;

    expect(await screen).toBeNull();
    expect(await undimmed).toBeNull();
    expect(await text).toBeNull();
    expect(await closed).toBeNull();
  });

  it('a read made after the id was taken reads the new session, not the old one still waiting', async () => {
    const sessions = sessionTable();
    sessions.map.set('pane-a', session('old pane screen'));
    const queue = holdQueue();
    const oldScreen = queuedScreenText(sessions, 'pane-a');
    const oldText = queuedTextSnapshot(sessions, 'pane-a', 100);

    sessions.map.set('pane-a', session('new pane screen'));
    const newScreen = queuedScreenText(sessions, 'pane-a');
    const newText = queuedTextSnapshot(sessions, 'pane-a', 100);
    queue.release();
    await queue.done;

    expect(await oldScreen).toBeNull();
    expect(await oldText).toBeNull();
    expect(lines(await newScreen)).toEqual(['new pane screen']);
    expect(lines(await newText)).toEqual(['new pane screen']);
  });

  it('two reads of the same live session still share one parse', async () => {
    const sessions = sessionTable();
    const pane = session('live pane screen');
    sessions.map.set('pane-a', pane);
    const queue = holdQueue();
    const first = queuedScreenText(sessions, 'pane-a');
    const second = queuedScreenText(sessions, 'pane-a');
    const firstText = queuedTextSnapshot(sessions, 'pane-a', 100);
    const secondText = queuedTextSnapshot(sessions, 'pane-a', 100);
    expect(second).toBe(first);
    expect(secondText).toBe(firstText);
    const lookupsBeforeTurn = sessions.lookups;
    queue.release();
    await queue.done;

    expect(lines(await first)).toEqual(['live pane screen']);
    expect(lines(await firstText)).toEqual(['live pane screen']);
    // One job ran per kind of read (screen, text), not one per caller: each
    // job looks its session up once at its turn.
    expect(sessions.lookups - lookupsBeforeTurn).toBe(2);
  });
});
