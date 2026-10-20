// The factory smoke graders (scripts/factory-graders) against fixture
// snapshots, no app launch. Each fixture under fixtures/factory-graders is
// `{ pass, fail: [{ why, failing, mutate }] }`: `pass` is a trimmed snapshot
// from a passing live run, every `fail` case is that snapshot with one
// behaviour broken (mutate ops), and must fail exactly the named criteria.
// The generic cases pin the scoring rule: no snapshot, a harness error or a
// missing source is an ERROR, never a FAIL.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS, gradeSnapshot } from '../factory-graders/index.mjs';
import { evidenceComplete } from '../factory-graders/common.mjs';
import { loadScenarios } from '../lib/factory-smoke-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'factory-graders');
const scenarios = new Map(loadScenarios().map((s) => [s.name, s]));

function walk(obj, parts) {
  let o = obj;
  for (const p of parts) o = o[/^\d+$/.test(p) ? Number(p) : p];
  return o;
}

/** set / remove / push at a dotted path (numeric parts index arrays). */
export function applyMutations(snap, ops) {
  const out = structuredClone(snap);
  for (const op of ops) {
    const parts = op.path.split('.');
    const last = parts.pop();
    const parent = walk(out, parts);
    const key = /^\d+$/.test(last) ? Number(last) : last;
    if (op.op === 'set') parent[key] = op.value;
    else if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(key, 1);
      else delete parent[key];
    } else if (op.op === 'push') parent[key].push(op.value);
    else throw new Error(`unknown op ${op.op}`);
  }
  return out;
}

describe('every scenario has a grader and a fixture', () => {
  for (const name of scenarios.keys()) {
    it(name, () => {
      expect(GRADERS[name], `grader for ${name}`).toBeTypeOf('function');
      expect(fs.existsSync(path.join(FIXTURES, `${name}.json`)), `fixture for ${name}`).toBe(true);
    });
  }
});

describe('fixtures', () => {
  for (const file of fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')) : []) {
    const name = file.replace(/\.json$/, '');
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const sc = scenarios.get(name);
    describe(name, () => {
      it('passes on the passing snapshot', () => {
        const g = gradeSnapshot(sc, fx.pass);
        expect(g.criteria.filter((c) => !c.pass)).toEqual([]);
        expect(g.status).toBe('pass');
      });
      for (const f of fx.fail ?? []) {
        it(`fails: ${f.why}`, () => {
          const g = gradeSnapshot(sc, applyMutations(fx.pass, f.mutate));
          expect(g.status).toBe('fail');
          expect(g.criteria.filter((c) => !c.pass).map((c) => c.name).sort()).toEqual([...f.failing].sort());
        });
      }
    });
  }
});

describe('scoring rule', () => {
  const sc = scenarios.get('reply-in-wake-thread');
  const ok = { schemaVersion: 1, harnessErrors: [], sources: { facts: { present: true, ok: true }, cards: { present: true, ok: true }, bots: { present: true, ok: true }, wakes: { present: true, ok: true } } };

  it('no snapshot is a harness error', () => {
    expect(gradeSnapshot(sc, null)).toEqual({ status: 'error', criteria: [expect.objectContaining({ name: 'evidence_complete', pass: false })] });
  });

  it('a recorded harness error is an error, not a fail', () => {
    expect(gradeSnapshot(sc, { ...ok, harnessErrors: ['launch failed'] }).status).toBe('error');
  });

  it('a missing or unreadable source the scenario needs is an error', () => {
    expect(gradeSnapshot(sc, { ...ok, sources: { ...ok.sources, wakes: { present: false, ok: false } } }).status).toBe('error');
    expect(gradeSnapshot(sc, { ...ok, sources: { ...ok.sources, cards: { present: true, ok: false } } }).status).toBe('error');
  });

  it('another schema version is an error', () => {
    expect(evidenceComplete({ ...ok, schemaVersion: 2 }).pass).toBe(false);
  });

  it('a complete snapshot with no behaviour fails closed, criterion by criterion', () => {
    const g = gradeSnapshot(sc, { ...ok, facts: [], cards: [], wakes: [], injected: [], botKeys: {} });
    expect(g.status).toBe('fail');
    expect(g.criteria[0]).toMatchObject({ name: 'evidence_complete', pass: true });
  });

  it('a grader that throws on malformed evidence fails closed', () => {
    const g = gradeSnapshot(sc, { ...ok, injected: 'not-a-list', wakes: 'nope' });
    expect(g.status).toBe('fail');
  });

  it('a scenario without a grader is an error', () => {
    expect(gradeSnapshot({ name: 'no-such-scenario', expect: {} }, { ...ok }).status).toBe('error');
  });
});

describe('a scenario that names no bystander', () => {
  it('fails its directed-fact grade instead of grading an unnamed bot', async () => {
    const { directedFactOnlyAddressee } = await import('../factory-graders/wakes.mjs');
    const names = directedFactOnlyAddressee({ facts: [], cards: [], wakes: [], injected: [], botKeys: {} }, { message: 'm', addressee: 'a' }).map((c) => c.id ?? c.name);
    expect(names).toContain('bystanders_named');
    expect(names.some((n) => String(n).startsWith('undefined'))).toBe(false);
  });
});

describe('research completion evidence', () => {
  const sc = scenarios.get('research-no-repo-closes');
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${sc.name}.json`), 'utf8')).pass;
  const cases = [
    { name: 'no attached evidence', items: [], verified: 0 },
    { name: 'only unverified evidence', items: [{ kind: 'inspection', status: 'unverified', summary: 'Not checked' }], verified: 0 },
    { name: 'mixed evidence', items: [
      { kind: 'command', status: 'passed', command: 'check', summary: 'Check passed' },
      { kind: 'artifact', status: 'verified', summary: 'Artifact checked' },
      { kind: 'inspection', status: 'unverified', summary: 'Not checked' },
    ], verified: 2 },
  ];
  for (const { name, items, verified } of cases) {
    describe(name, () => {
      function sample() {
        const snap = structuredClone(fixture);
        snap.ledger[0].verifiedItemCount = verified;
        if (items.length) snap.ledger[0].evidence = { summary: 'Research evidence', items };
        const card = snap.cards[2];
        card.title = 'Localized title';
        card.body = 'Localized explanation';
        card.notice = { code: verified > 0 ? 'research.completed' : 'research.unverified', args: { verified, total: items.length } };
        const scenario = { ...sc, expect: { ...sc.expect, evidence: { verified, total: items.length } } };
        return { snap, scenario };
      }
      it('uses the notice and evidence grade, independent of English copy', () => {
        const { snap, scenario } = sample();
        expect(gradeSnapshot(scenario, snap).status).toBe('pass');
      });
      for (const [label, mutate, criterion] of [
        ['missing ledger grade', (s) => { delete s.ledger[0].verifiedItemCount; }, 'evidence_grade'],
        ['inflated ledger grade', (s) => { s.ledger[0].verifiedItemCount++; }, 'evidence_grade'],
        ['wrong notice code', (s) => { s.cards[2].notice.code = 'research.notCompleted'; }, 'closed_card'],
        ['wrong verified count', (s) => { s.cards[2].notice.args.verified++; }, 'closed_card'],
        ['wrong total count', (s) => { s.cards[2].notice.args.total++; }, 'closed_card'],
        ['another task card', (s) => { s.cards[2].threadId = 'task:other'; }, 'closed_card'],
        ['English title without a notice', (s) => { delete s.cards[2].notice; s.cards[2].title = 'Research reported: task completed'; }, 'closed_card'],
        ['contradictory completion card', (s) => { const other = structuredClone(s.cards[2]); other.notice.code = other.notice.code === 'research.completed' ? 'research.unverified' : 'research.completed'; s.cards.push(other); }, 'closed_card'],
        ['duplicate completion card', (s) => { s.cards.push(structuredClone(s.cards[2])); }, 'closed_card'],
      ]) {
        it(`rejects ${label}`, () => {
          const { snap, scenario } = sample();
          mutate(snap);
          expect(gradeSnapshot(scenario, snap).criteria.filter((c) => !c.pass).map((c) => c.name)).toEqual([criterion]);
        });
      }
      if (verified > 0) it('rejects evidence downgraded after the recorded grade', () => {
        const { snap, scenario } = sample();
        snap.ledger[0].evidence = structuredClone(snap.ledger[0].evidence);
        snap.ledger[0].evidence.items[0].status = 'failed';
        expect(gradeSnapshot(scenario, snap).criteria.filter((c) => !c.pass).map((c) => c.name)).toEqual(['evidence_grade']);
      });
    });
  }
});
