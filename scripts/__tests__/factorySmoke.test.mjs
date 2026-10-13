// scripts/lib/factory-smoke-lib.mjs: the templates, the evidence snapshot and
// the wait conditions of the factory smoke runner, without an app.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSnapshot,
  collapseById,
  conditionHolds,
  fillTemplate,
  foldLedger,
  parseJsonl,
  selectCard,
} from '../lib/factory-smoke-lib.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp9-fsmoke-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

describe('fillTemplate', () => {
  it('fills known names deep, keeps a whole-placeholder value typed, leaves unknown names', () => {
    const out = fillTemplate({ a: '{{n}}', b: ['x {{bot.lead}} y'], c: '{{prompt}} / {{saved.head}}' }, { n: 3, bot: { lead: 'bot-1' }, saved: {} });
    expect(out).toEqual({ a: 3, b: ['x bot-1 y'], c: '{{prompt}} / {{saved.head}}' });
  });
});

describe('jsonl and folds', () => {
  it('counts torn lines instead of failing', () => {
    expect(parseJsonl('{"a":1}\n{bad\n\n{"a":2}\n')).toEqual({ rows: [{ a: 1 }, { a: 2 }], errors: 1 });
  });

  it('collapses by id, last line wins', () => {
    expect(collapseById([{ id: 'h1', s: 'queued' }, { id: 'h2', s: 'x' }, { id: 'h1', s: 'delivered' }])).toEqual([{ id: 'h1', s: 'delivered' }, { id: 'h2', s: 'x' }]);
  });

  it('folds the task ledger op log; a snapshot line replaces what came before', () => {
    const rows = foldLedger([
      { op: 'entry', entry: { id: 't1', status: 'working' } },
      { op: 'orphaned_event', event: {} },
      { op: 'snapshot', entries: [{ id: 't2', status: 'working' }], orphans: [] },
      { op: 'entry', entry: { id: 't2', status: 'review_requested' } },
    ]);
    expect(rows).toEqual([{ id: 't2', status: 'review_requested' }]);
  });
});

describe('buildSnapshot', () => {
  it('records which sources were present and readable', () => {
    write('factory/facts.jsonl', '{"id":"f1","kind":"pr.opened"}\n');
    write('factory/wake-queue.json', '{"version":1,"items":[{"id":"w1","state":"done"}]}');
    write('factory/bots.json', '{not json');
    write('factory/rooms/ws-a.jsonl', '{"id":"c2","seq":2,"workspaceId":"ws-a"}\n{"id":"c1","seq":1,"workspaceId":"ws-a"}\n');
    write('stub.jsonl', '{"event":"prompt"}\n');
    const snap = buildSnapshot({ wmuxDir: dir, scenario: 's', run: 1, logs: { stub: { lead: path.join(dir, 'stub.jsonl') } }, injected: [{ label: 'x' }], errors: [] });
    expect(snap.sources.facts).toEqual({ present: true, ok: true, errors: 0 });
    expect(snap.sources.bots).toEqual({ present: true, ok: false, errors: 1 });
    expect(snap.sources.handoffs.present).toBe(false);
    expect(snap.wakes).toEqual([{ id: 'w1', state: 'done' }]);
    expect(snap.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(snap.stub.lead).toEqual([{ event: 'prompt' }]);
    expect(snap.schemaVersion).toBe(1);
  });

  it('a malformed line or a file without its list is present but not ok', () => {
    write('factory/facts.jsonl', '{"id":"f1"}\n{torn\n');
    write('factory/wake-queue.json', '{"version":1}');
    write('gh.jsonl', '{"argv":["api"]}\n');
    const snap = buildSnapshot({ wmuxDir: dir, scenario: 's', run: 1, logs: { ghCalls: path.join(dir, 'gh.jsonl'), workers: path.join(dir, 'none.jsonl') } });
    expect(snap.sources.facts).toEqual({ present: true, ok: false, errors: 1 });
    expect(snap.sources.wakes).toMatchObject({ present: true, ok: false });
    expect(snap.sources.ghCalls).toEqual({ present: true, ok: true, errors: 0 });
    expect(snap.sources.workers).toEqual({ present: false, ok: false, errors: 0 });
  });

  it('never exports the bot token hand-off files', () => {
    write('factory/handoff/bot-00000000-aa.token', 'secret');
    const snap = buildSnapshot({ wmuxDir: dir, scenario: 's', run: 1 });
    expect(JSON.stringify(snap)).not.toContain('secret');
  });
});

describe('conditionHolds', () => {
  const state = {
    wakes: [{ botId: 'bot-1', state: 'done', reason: { kind: 'human' } }, { botId: 'bot-2', state: 'queued', reason: { kind: 'facts' } }],
    facts: [{ kind: 'pr.opened' }],
    cards: [{ kind: 'question', state: 'open', threadId: 'pr:x#1', actor: { botId: 'bot-1' } }],
    handoffs: [{ kind: 'result', status: 'refused' }],
    ledger: [{ status: 'review_requested' }],
    stub: { lead: [{ event: 'tool', name: 'room_post' }] },
    workers: [{ event: 'commit' }],
    gh: { calls: [{ argv: ['pr', 'merge', '1'] }] },
    repoWatch: { repos: { 'github.com/acme/app': {} } },
    approvals: [{ state: 'executed', decidedBy: 'rule', prNumber: 2 }, { state: 'pending', prNumber: 1 }],
  };
  const ids = { lead: 'bot-1' };

  it('matches each kind of condition, with min / max', () => {
    expect(conditionHolds({ wakes: { bot: 'lead', state: 'done' } }, state, ids)).toBe(true);
    expect(conditionHolds({ wakes: { bot: 'lead', state: 'done', min: 2 } }, state, ids)).toBe(false);
    expect(conditionHolds({ wakes: { state: ['queued', 'running'], max: 0 } }, state, ids)).toBe(false);
    expect(conditionHolds({ facts: { kind: 'pr.opened' } }, state, ids)).toBe(true);
    expect(conditionHolds({ cards: { kind: 'question', state: 'open', threadPrefix: 'pr:', actorBot: 'lead' } }, state, ids)).toBe(true);
    expect(conditionHolds({ handoffs: { kind: 'result', status: 'delivered' } }, state, ids)).toBe(false);
    expect(conditionHolds({ ledger: { status: 'review_requested' } }, state, ids)).toBe(true);
    expect(conditionHolds({ stub: { bot: 'lead', tool: 'room_post' } }, state, ids)).toBe(true);
    expect(conditionHolds({ workers: { event: 'commit' } }, state, ids)).toBe(true);
    expect(conditionHolds({ gh: { cmd: 'pr merge' } }, state, ids)).toBe(true);
    expect(conditionHolds({ repoWatch: { repo: 'github.com/acme/app' } }, state, ids)).toBe(true);
    expect(conditionHolds({ approvals: { state: 'executed', decidedBy: 'rule', pr: 2 } }, state, ids)).toBe(true);
    expect(conditionHolds({ approvals: { state: 'executed', min: 2 } }, state, ids)).toBe(false);
  });

  it('idle means nothing queued or running; all / any combine', () => {
    expect(conditionHolds({ idle: true }, state, ids)).toBe(false);
    expect(conditionHolds({ any: [{ idle: true }, { facts: { kind: 'pr.opened' } }] }, state, ids)).toBe(true);
    expect(conditionHolds({ all: [{ idle: true }, { facts: { kind: 'pr.opened' } }] }, state, ids)).toBe(false);
  });

  it('an unknown or empty condition never holds (a wait cannot pass by accident)', () => {
    expect(conditionHolds({}, state, ids)).toBe(false);
    expect(conditionHolds({ nope: 1 }, state, ids)).toBe(false);
    expect(conditionHolds(null, state, ids)).toBe(false);
  });
});

describe('selectCard', () => {
  it('takes the newest matching card', () => {
    const cards = [{ id: 'a', kind: 'plan', state: 'open' }, { id: 'b', kind: 'plan', state: 'open' }, { id: 'c', kind: 'plan', state: 'resolved' }];
    expect(selectCard(cards, { kind: 'plan', state: 'open' })?.id).toBe('b');
    expect(selectCard(cards, { kind: 'question' })).toBeNull();
  });
});
