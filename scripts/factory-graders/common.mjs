// Shared pieces of the factory smoke graders (scripts/factory-graders/*.mjs).
//
// A grader is a pure function `(snapshot, expect) → Criterion[]` over the
// evidence snapshot scripts/factory-smoke.mjs exports after the instance
// stopped. `evidence_complete` runs first for every scenario and decides
// whether the run can be scored at all: a snapshot that is missing, written
// by an older schema, recorded a harness error, or lacks a source the
// scenario needs is a harness ERROR, never a behaviour FAIL.

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Sources every scenario needs unless it says otherwise. */
export const DEFAULT_REQUIRES = ['facts', 'cards', 'bots'];

export function criterion(name, pass, detail = '') {
  return { name, pass: pass === true, detail: String(detail).slice(0, 600) };
}

export function evidenceComplete(snap, requires = DEFAULT_REQUIRES) {
  if (!snap || typeof snap !== 'object') return criterion('evidence_complete', false, 'no snapshot was exported');
  if (snap.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return criterion('evidence_complete', false, `snapshot schema ${snap.schemaVersion} is not ${SNAPSHOT_SCHEMA_VERSION}`);
  if (Array.isArray(snap.harnessErrors) && snap.harnessErrors.length > 0) {
    return criterion('evidence_complete', false, `harness error: ${snap.harnessErrors[0]}`);
  }
  const sources = snap.sources ?? {};
  const missing = requires.filter((s) => !sources[s]?.present || !sources[s]?.ok);
  if (missing.length > 0) return criterion('evidence_complete', false, `missing or unreadable: ${missing.join(', ')}`);
  return criterion('evidence_complete', true, `sources: ${requires.join(', ')}`);
}

// ── snapshot readers (null-safe) ───────────────────────────────────────────

export const arr = (v) => (Array.isArray(v) ? v : []);

export function botId(snap, key) {
  return snap?.botKeys?.[key] ?? null;
}

export function wakesOf(snap, key) {
  const id = botId(snap, key);
  return arr(snap.wakes).filter((w) => w.botId === id);
}

export function botCards(snap, key) {
  const id = botId(snap, key);
  return arr(snap.cards).filter((c) => c.actor?.kind === 'bot' && c.actor.botId === id);
}

export function cardsOfKind(snap, kind) {
  return arr(snap.cards).filter((c) => c.kind === kind);
}

export function factsOfKind(snap, kind) {
  return arr(snap.facts).filter((f) => f.kind === kind);
}

export function injected(snap, label) {
  return arr(snap.injected).find((i) => i.label === label) ?? null;
}

export function stubEvents(snap, key, event) {
  return arr(snap.stub?.[key]).filter((e) => !event || e.event === event);
}

/** Tool calls the stub of `key` made (name, ok, text). */
export function stubTools(snap, key, name) {
  return stubEvents(snap, key, 'tool').filter((e) => !name || e.name === name);
}

/** A JSON value inside a tool result text (the MCP tools answer JSON text). */
export function parseToolText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export function handoffsOfKind(snap, kind) {
  return arr(snap.handoffs).filter((h) => h.kind === kind);
}

/** The `facts` wakes whose reason names fact `factId`. */
export function wakesForFact(snap, factId) {
  return arr(snap.wakes).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).includes(factId));
}
