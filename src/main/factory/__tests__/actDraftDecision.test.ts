// A refused release row's draft is decided (deleted or kept) and that is
// journaled (decideDraft): a quit between the refusal and the decision
// leaves the row undecided on disk, and the next sweep decides it under the
// same rules, telling the request (its refusal amended) once.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalReleaseAct } from '../../../shared/botApproval';
import { ActEffectStore, DRAFT_OPEN_MAX_MS, actEffectId, draftUndecided, type ActEffect } from '../actEffectStore';
import { ActExecutor } from '../actExecutor';
import type { StoredApproval } from '../approvals';
import { FakeGithub } from './fakeGithubActs';

const ID = 'apr-aaaaaaaaaaaa';
const C3 = '3'.repeat(40);
const TAG = 'v1.2.3';

let dir = '';
let file = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-act-draft-'));
  file = path.join(dir, 'factory', 'act-effects.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const act: ApprovalReleaseAct = {
  kind: 'release', mode: 'release', tagName: TAG, targetSha: C3, defaultBranch: 'main', title: 'wmux 1.2.3', notes: 'Fixes.', prerelease: false, workflows: [], pushWorkflows: [], checksExpected: false, draft: false,
};

/** A release row refused with its draft journaled and not decided: what a
 *  quit right after the refusal leaves on disk. */
function refusedUndecided(): { store: ActEffectStore; id: string } {
  const store = new ActEffectStore(file);
  const id = actEffectId(ID);
  store.enqueue({ requestId: ID, action: 'release', repoKey: 'github.com/o/r', payloadHash: 'h' });
  store.claim(id);
  store.noteDraft(id, 50);
  store.finish(id, 'refused', 'checks-failing');
  return { store: new ActEffectStore(file), id };
}

function github(): FakeGithub {
  const gh = new FakeGithub();
  gh.history = [C3];
  gh.releases = [{ id: 50, tag_name: TAG, draft: true, prerelease: false, name: act.title, body: act.notes, target_commitish: C3, author: { login: 'owner' }, html_url: 'https://github.com/o/r/releases/tag/x' }];
  return gh;
}

/** `approvals`: the request is there (refused), gone, or the approvals are
 *  not up yet (a start). */
function executor(store: ActEffectStore, gh: FakeGithub, approvals: 'there' | 'gone' | 'not-running' = 'there', now?: () => number) {
  const emitted: ActEffect[] = [];
  const lines: string[] = [];
  const request = { requestId: ID, repoKey: 'github.com/o/r', act, ghLogin: 'owner' } as unknown as StoredApproval;
  const ex = new ActExecutor({
    effects: store, gh,
    approval: {
      request: () => (approvals === 'there' ? request : null),
      authorize: () => (approvals === 'gone' ? 'approval-missing' : approvals === 'not-running' ? 'approval-not-running' : 'approval-not-approved'),
    },
    emit: (e) => emitted.push(e),
    log: (l) => lines.push(l),
    ...(now ? { now } : {}),
  });
  return { ex, emitted, lines };
}

describe('a refused release row\'s draft decision', () => {
  it('a release row refused with a draft has it open in the same write; decided, it is not; a row an earlier build refused never is', () => {
    const { store, id } = refusedUndecided();
    expect(store.get(id)).toMatchObject({ status: 'refused', draftOpen: true });
    expect(draftUndecided({ status: 'refused', draftOpen: true })).toBe(true);
    expect(draftUndecided({ status: 'refused' })).toBe(false);
    expect(draftUndecided({ status: 'uncertain', draftOpen: true })).toBe(false);
    // A row with no draft is never open.
    const plain = new ActEffectStore(path.join(dir, 'plain.json'));
    plain.enqueue({ requestId: ID, action: 'release', repoKey: 'github.com/o/r', payloadHash: 'h' });
    plain.claim(id);
    expect(plain.finish(id, 'refused', 'checks-failing')).not.toHaveProperty('draftOpen');
  });

  it('an undecided row is not removed with its request; decided, it is', () => {
    const { store, id } = refusedUndecided();
    store.remove(id);
    expect(store.get(id)).not.toBeNull();
    const decided = store.decideDraft(id);
    expect(decided).toMatchObject({ reason: 'checks-failing' });
    expect(decided).not.toHaveProperty('draftOpen');
    store.remove(id);
    expect(store.get(id)).toBeNull();
  });

  it('the sweep decides a draft a quit left undecided: deleted, the reason unchanged, journaled', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    const { ex, emitted } = executor(store, gh);
    await ex.reconcileAll();
    expect(gh.releases).toEqual([]);
    expect(new ActEffectStore(file).get(id)).toMatchObject({ status: 'refused', reason: 'checks-failing' });
    expect(new ActEffectStore(file).get(id)).not.toHaveProperty('draftOpen');
    expect(emitted.at(-1)).toMatchObject({ status: 'refused', reason: 'checks-failing' });
    // Decided once: the next sweep leaves it.
    await ex.reconcileAll();
    expect(gh.writes.map((w) => w.method)).toEqual(['DELETE']);
  });

  it('the sweep keeps a draft whose tag is made and amends the reason with its code', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    gh.tags.set(TAG, { sha: C3 });
    const { ex, emitted } = executor(store, gh);
    await ex.reconcileAll();
    expect(gh.releases).toHaveLength(1);
    expect(new ActEffectStore(file).get(id)).toMatchObject({ reason: 'checks-failing, draft-kept-tag-made' });
    expect(new ActEffectStore(file).get(id)).not.toHaveProperty('draftOpen');
    expect(emitted.at(-1)).toMatchObject({ reason: 'checks-failing, draft-kept-tag-made' });
  });

  it('a row whose request is gone is decided from its draft\'s own tag, then dropped', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    const { ex, lines } = executor(store, gh, 'gone');
    await ex.reconcileAll();
    expect(gh.releases).toEqual([]);
    expect(store.get(id)).toBeNull();
    expect(lines.some((l) => /draft 50: deleted/.test(l))).toBe(true);
  });

  it('while the approvals are not up (a start), nothing is decided', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    const { ex, emitted } = executor(store, gh, 'not-running');
    await ex.reconcileAll();
    expect(gh.writes).toEqual([]);
    expect(emitted).toEqual([]);
    expect(store.get(id)).toMatchObject({ status: 'refused', draftOpen: true });
  });

  it('a read GitHub did not answer leaves the draft open, untold, for a later sweep; GitHub\'s own refusal of the delete is told', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    gh.answerRead = (e) => (e === 'repos/o/r/releases/50' ? { ok: false, kind: 'error', message: 'timeout' } : null);
    const { ex, emitted } = executor(store, gh);
    await ex.reconcileAll();
    expect(store.get(id)).toMatchObject({ draftOpen: true, reason: 'checks-failing' });
    expect(emitted).toEqual([]);
    // A delete GitHub did not answer: open still.
    gh.answerRead = null;
    gh.nextWrite = { answer: { ok: false, kind: 'error', message: 'timeout' }, landed: false };
    await ex.reconcileAll();
    expect(store.get(id)).toMatchObject({ draftOpen: true });
    // GitHub refused the delete: decided, and told.
    gh.nextWrite = { answer: { ok: false, kind: 'http', status: 500, message: 'gh: Server Error (HTTP 500)' }, landed: false };
    await ex.reconcileAll();
    expect(store.get(id)).toMatchObject({ reason: 'checks-failing, draft-not-deleted' });
    expect(store.get(id)).not.toHaveProperty('draftOpen');
    expect(emitted.at(-1)).toMatchObject({ reason: 'checks-failing, draft-not-deleted' });
  });

  it('a row an earlier build refused with a draft (no flag) is left as it was decided then', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { id: actEffectId(ID), requestId: ID, action: 'release', repoKey: 'github.com/o/r', payloadHash: 'h', status: 'refused', reason: 'checks-failing', attempt: 1, draftId: 50, createdAt: 1, updatedAt: 1 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, effects: [legacy] }));
    const store = new ActEffectStore(file);
    const gh = github();
    const { ex, emitted } = executor(store, gh);
    await ex.reconcileAll();
    expect(gh.reads.filter((e) => e.startsWith('repos/o/r/releases/'))).toEqual([]);
    expect(gh.writes).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('a draft GitHub does not answer for stays open a day at most: then it is kept, not checked, and told', async () => {
    const { store, id } = refusedUndecided();
    const openedAt = store.get(id)?.draftOpenAt ?? 0;
    expect(openedAt).toBeGreaterThan(0);
    const gh = github();
    gh.answerRead = (e) => (e === 'repos/o/r/releases/50' ? { ok: false, kind: 'error', message: 'gh: not logged in' } : null);
    let now = openedAt + DRAFT_OPEN_MAX_MS - 1;
    const { ex, emitted } = executor(store, gh, 'there', () => now);
    await ex.reconcileAll();
    expect(store.get(id)).toMatchObject({ draftOpen: true });
    expect(emitted).toEqual([]);
    now = openedAt + DRAFT_OPEN_MAX_MS;
    await ex.reconcileAll();
    expect(store.get(id)).toMatchObject({ reason: 'checks-failing, draft-kept-unchecked' });
    expect(store.get(id)).not.toHaveProperty('draftOpen');
    expect(emitted.at(-1)).toMatchObject({ reason: 'checks-failing, draft-kept-unchecked' });
    expect(gh.releases).toHaveLength(1);
  });
});
