// Pure helpers for scripts/factory-smoke.mjs: scenario templates, the
// evidence snapshot read from an instance's data dir, and the wait
// conditions the runner polls. Kept apart from the runner so the parts that
// decide what a run produced can be unit tested without launching wmux
// (scripts/__tests__/factorySmoke.test.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_SCHEMA_VERSION = 1;

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'factory-scenarios');

/** The scenario files under scripts/factory-scenarios, by file name. Here and
 *  not in the runner so a test can load them without importing the runner. */
export function loadScenarios(dir = SCENARIO_DIR) {
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const sc = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      return { file: n, ...sc };
    });
}

/** Sources a snapshot reads, relative to the instance's wmux data dir. */
export const SNAPSHOT_SOURCES = {
  facts: { file: 'factory/facts.jsonl', kind: 'jsonl' },
  wakes: { file: 'factory/wake-queue.json', kind: 'json', pick: (j) => j.items, list: true },
  handoffs: { file: 'factory/handoffs.jsonl', kind: 'jsonl', collapse: true },
  bots: { file: 'factory/bots.json', kind: 'json', pick: (j) => j.bots, list: true },
  settings: { file: 'factory/settings.json', kind: 'json' },
  repoWatch: { file: 'factory/repo-watch.json', kind: 'json' },
  ledger: { file: 'task-ledger.jsonl', kind: 'jsonl', fold: foldLedger },
  verdicts: { file: 'pr-verdicts.json', kind: 'json', pick: (j) => j.verdicts, list: true },
  effects: { file: 'moa-delegate/effects.json', kind: 'json', pick: (j) => j.effects, list: true },
  approvals: { file: 'factory/approvals.json', kind: 'json', pick: (j) => j.requests, list: true },
  approvalRules: { file: 'factory/approvals.json', kind: 'json', pick: (j) => j.rules, list: true },
  decisions: { file: 'deck-decisions.json', kind: 'json' },
  routines: { file: 'factory/routines.json', kind: 'json', pick: (j) => j.routines, list: true },
};

// ── templates ───────────────────────────────────────────────────────────────

function lookup(vars, dotted) {
  let v = vars;
  for (const part of dotted.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object' || !(part in v)) return undefined;
    v = v[part];
  }
  return v;
}

/**
 * Replace `{{a.b}}` from `vars` in every string of `value` (deep). A string
 * that is exactly one placeholder takes the value itself (so a number stays
 * a number); an unknown name is left as written, so a stub's own runtime
 * placeholders ({{prompt}}, its `save` captures) pass through untouched.
 */
export function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\{\{([\w.]+)\}\}$/.exec(value);
    if (whole) {
      const v = lookup(vars, whole[1]);
      return v === undefined ? value : v;
    }
    return value.replace(/\{\{([\w.]+)\}\}/g, (m, k) => {
      const v = lookup(vars, k);
      return v === undefined ? m : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]));
  }
  return value;
}

// ── reading the instance's files ────────────────────────────────────────────

/** Parse JSON lines; a torn or malformed line is counted, never fatal. */
export function parseJsonl(text) {
  const rows = [];
  let errors = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      errors += 1;
    }
  }
  return { rows, errors };
}

/** Records keyed by `id`, the last line of an id winning, in first-seen order. */
export function collapseById(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (r && typeof r.id === 'string') byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** The task ledger's rows from its op log (TaskLedger: `entry` lines and
 *  `snapshot` lines; the last write of an id wins). */
export function foldLedger(lines) {
  const byId = new Map();
  for (const l of lines) {
    if (l?.op === 'snapshot' && Array.isArray(l.entries)) {
      byId.clear();
      for (const e of l.entries) if (e && typeof e.id === 'string') byId.set(e.id, e);
    } else if (l?.op === 'entry' && l.entry && typeof l.entry.id === 'string') byId.set(l.entry.id, l.entry);
  }
  return [...byId.values()];
}

/** One source: `{present, ok, errors, data}`. Missing file → present:false;
 *  a malformed line, or a file without the list it should hold → ok:false
 *  (the instance has stopped when the snapshot is read, so nothing is torn
 *  by a writer still at work). */
export function readSource(wmuxDir, spec) {
  const file = path.join(wmuxDir, spec.file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false, ok: false, errors: 0, data: null };
  }
  if (spec.kind === 'jsonl') {
    const { rows, errors } = parseJsonl(text);
    const data = spec.fold ? spec.fold(rows) : spec.collapse ? collapseById(rows) : rows;
    return { present: true, ok: errors === 0, errors, data };
  }
  try {
    const json = JSON.parse(text);
    const data = spec.pick ? spec.pick(json) ?? null : json;
    const ok = !spec.list || Array.isArray(data);
    return { present: true, ok, errors: ok ? 0 : 1, data };
  } catch {
    return { present: true, ok: false, errors: 1, data: null };
  }
}

/** Every room card of the instance (`factory/rooms/<ws>.jsonl`), seq order,
 *  one per card id (its latest line). */
export function readCards(wmuxDir) {
  const dir = path.join(wmuxDir, 'factory', 'rooms');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { present: false, ok: false, errors: 0, data: null };
  }
  const cards = [];
  let errors = 0;
  for (const n of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, n), 'utf8');
    } catch {
      // Gone between the listing and the read: counted, not fatal.
      errors += 1;
      continue;
    }
    const parsed = parseJsonl(text);
    errors += parsed.errors;
    cards.push(...parsed.rows);
  }
  // A card whose state changes (a question resolved) is appended again with
  // the same id: the last line is the card, at its first seq.
  const latest = new Map();
  for (const c of cards) {
    const key = `${c?.workspaceId}\u0000${c?.id}`;
    const prev = latest.get(key);
    latest.set(key, prev ? { ...c, seq: Math.min(prev.seq, c.seq) } : c);
  }
  const data = [...latest.values()].sort((a, b) => (a.workspaceId === b.workspaceId ? a.seq - b.seq : String(a.workspaceId).localeCompare(String(b.workspaceId))));
  return { present: true, ok: errors === 0, errors, data };
}

/** A JSONL log written by a harness stand-in (stub, worker, fake gh). */
export function readLog(file) {
  return readLogStatus(file).rows;
}

/** A stand-in log with its read status: absent (nothing was ever logged),
 *  or present and parsed (ok only when every line parsed). */
export function readLogStatus(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false, ok: false, errors: 0, rows: [] };
  }
  const { rows, errors } = parseJsonl(text);
  return { present: true, ok: errors === 0, errors, rows };
}

/** The live state of an instance as the wait conditions see it. */
export function readLiveState(wmuxDir, logs = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(SNAPSHOT_SOURCES)) out[name] = readSource(wmuxDir, spec).data;
  out.cards = readCards(wmuxDir).data;
  out.stub = Object.fromEntries(Object.entries(logs.stub ?? {}).map(([k, f]) => [k, readLog(f)]));
  out.workers = logs.workers ? readLog(logs.workers) : [];
  out.gh = { calls: logs.ghCalls ? readLog(logs.ghCalls) : [] };
  return out;
}

/**
 * The evidence snapshot of one run: every source with its read status, the
 * harness logs, and what the runner injected. `sources` records what was
 * read so a grader can tell a missing file (harness failure) from an empty
 * one (behaviour).
 */
export function buildSnapshot({ wmuxDir, scenario, run, logs = {}, injected = [], actions = [], errors = [], bots = {}, workspaceId = null, extra = {} }) {
  const sources = {};
  const snap = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    scenario,
    run,
    workspaceId,
    bots: [],
    botKeys: bots,
    injected,
    actions,
    harnessErrors: errors,
  };
  for (const [name, spec] of Object.entries(SNAPSHOT_SOURCES)) {
    const r = readSource(wmuxDir, spec);
    sources[name] = { present: r.present, ok: r.ok, errors: r.errors };
    snap[name] = r.data;
  }
  const cards = readCards(wmuxDir);
  sources.cards = { present: cards.present, ok: cards.ok, errors: cards.errors };
  snap.cards = cards.data;
  snap.stub = Object.fromEntries(Object.entries(logs.stub ?? {}).map(([k, f]) => [k, readLog(f)]));
  const status = ({ present, ok, errors }) => ({ present, ok, errors });
  const workers = logs.workers ? readLogStatus(logs.workers) : null;
  const ghCalls = logs.ghCalls ? readLogStatus(logs.ghCalls) : null;
  if (workers) sources.workers = status(workers);
  if (ghCalls) sources.ghCalls = status(ghCalls);
  snap.workers = workers?.rows ?? [];
  snap.gh = { calls: ghCalls?.rows ?? [], state: null };
  if (logs.ghState) {
    try {
      snap.gh.state = JSON.parse(fs.readFileSync(logs.ghState, 'utf8'));
    } catch {
      snap.gh.state = null;
    }
  }
  snap.sources = sources;
  return { ...snap, ...extra };
}

/** Lines of the app log that are about the factory (bounded). */
export function appLogExcerpt(text, max = 400) {
  const keep = /\[factory\]|\[fanout\]|\[acp|acp-stub|bot-[0-9a-f]{8}|merge lane|verdict|wake/i;
  const lines = String(text ?? '').split('\n').filter((l) => keep.test(l)).map((l) => l.slice(0, 600));
  return lines.length > max ? lines.slice(-max) : lines;
}

// ── wait conditions ─────────────────────────────────────────────────────────

function count(xs, pred) {
  return (Array.isArray(xs) ? xs : []).filter(pred).length;
}

function inList(want, v) {
  if (want === undefined) return true;
  return Array.isArray(want) ? want.includes(v) : want === v;
}

/**
 * Whether `cond` holds over a live state. `botIds` maps scenario bot keys to
 * ids. Conditions:
 *   {wakes:{bot?, state?, reason?, min?, max?}}   {facts:{kind?, min?, max?}}
 *   {cards:{kind?, state?, threadPrefix?, actorBot?, min?, max?}}
 *   {handoffs:{kind?, status?, min?}}  {ledger:{status?, min?}}
 *   {routines:{state?, reason?, min?}} (reason: why a paused one is paused)
 *   {stub:{bot, event?, tool?, min?}}  {workers:{event?, min?}}
 *   {gh:{cmd?, min?}}  {repoWatch:{repo}} (its baseline was taken)
 *   {approvals:{state?, decidedBy?, pr?, min?, max?}} (factory/approvals.json requests)
 *   {all:[…]}  {any:[…]}  {idle:true}
 * min defaults to 1. `idle` = no wake queued or running.
 */
export function conditionHolds(cond, state, botIds = {}) {
  if (!cond || typeof cond !== 'object') return false;
  if (Array.isArray(cond.all)) return cond.all.every((c) => conditionHolds(c, state, botIds));
  if (Array.isArray(cond.any)) return cond.any.some((c) => conditionHolds(c, state, botIds));
  const within = (n, c) => n >= (c.min ?? 1) && (c.max === undefined || n <= c.max);
  if (cond.idle) return count(state.wakes, (w) => w.state === 'queued' || w.state === 'running') === 0;
  if (cond.wakes) {
    const c = cond.wakes;
    const bot = c.bot ? botIds[c.bot] ?? c.bot : undefined;
    return within(count(state.wakes, (w) => (!bot || w.botId === bot) && inList(c.state, w.state) && inList(c.reason, w.reason?.kind)), c);
  }
  if (cond.facts) {
    const c = cond.facts;
    return within(count(state.facts, (f) => inList(c.kind, f.kind)), c);
  }
  if (cond.cards) {
    const c = cond.cards;
    const actorBot = c.actorBot ? botIds[c.actorBot] ?? c.actorBot : undefined;
    return within(count(state.cards, (k) => inList(c.kind, k.kind) && inList(c.state, k.state)
      && (!c.threadPrefix || String(k.threadId).startsWith(c.threadPrefix))
      && (!actorBot || k.actor?.botId === actorBot)), c);
  }
  if (cond.handoffs) {
    const c = cond.handoffs;
    return within(count(state.handoffs, (h) => inList(c.kind, h.kind) && inList(c.status, h.status)), c);
  }
  if (cond.routines) {
    const c = cond.routines;
    return within(count(state.routines, (r) => inList(c.state, r.state) && inList(c.reason, r.paused?.reason)), c);
  }
  if (cond.ledger) {
    const c = cond.ledger;
    return within(count(state.ledger, (e) => inList(c.status, e.status)), c);
  }
  if (cond.stub) {
    const c = cond.stub;
    return within(count(state.stub?.[c.bot], (e) => inList(c.event, e.event) && inList(c.tool, e.name)), c);
  }
  if (cond.workers) {
    const c = cond.workers;
    return within(count(state.workers, (e) => inList(c.event, e.event)), c);
  }
  if (cond.approvals) {
    const c = cond.approvals;
    return within(count(state.approvals, (r) => inList(c.state, r.state) && inList(c.decidedBy, r.decidedBy) && inList(c.pr, r.prNumber)), c);
  }
  if (cond.repoWatch) {
    return !!state.repoWatch?.repos?.[cond.repoWatch.repo];
  }
  if (cond.gh) {
    const c = cond.gh;
    return within(count(state.gh?.calls, (e) => !c.cmd || (e.argv ?? []).join(' ').startsWith(c.cmd)), c);
  }
  return false;
}

/** Find one card for an action selector ({kind?, state?, threadPrefix?, actorBot?}), newest first. */
export function selectCard(cards, sel, botIds = {}) {
  const actorBot = sel.actorBot ? botIds[sel.actorBot] ?? sel.actorBot : undefined;
  const hits = (cards ?? []).filter((k) => inList(sel.kind, k.kind) && inList(sel.state, k.state)
    && (!sel.threadPrefix || String(k.threadId).startsWith(sel.threadPrefix))
    && (!actorBot || k.actor?.botId === actorBot));
  return hits.length ? hits[hits.length - 1] : null;
}
