// A refused release row's draft is decided (deleted or kept) and that is
// journaled (decideDraft): a quit between the refusal and the decision
// leaves the row undecided on disk, and the next sweep decides it under the
// same rules, telling the request (its refusal amended) once.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalReleaseAct } from '../../../shared/botApproval';
import { ActEffectStore, actEffectId, draftUndecided, type ActEffect } from '../actEffectStore';
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

function executor(store: ActEffectStore, gh: FakeGithub, requestGone = false) {
  const emitted: ActEffect[] = [];
  const lines: string[] = [];
  const request = { requestId: ID, repoKey: 'github.com/o/r', act, ghLogin: 'owner' } as unknown as StoredApproval;
  const ex = new ActExecutor({
    effects: store, gh,
    approval: { request: () => (requestGone ? null : request), authorize: () => (requestGone ? 'approval-missing' : 'approval-not-approved') },
    emit: (e) => emitted.push(e),
    log: (l) => lines.push(l),
  });
  return { ex, emitted, lines };
}

describe('a refused release row\'s draft decision', () => {
  it('a row refused without its draft decided is undecided; one decided, or that an earlier build told with a draft code, is not', () => {
    const base = { action: 'release' as const, status: 'refused' as const, draftId: 50, reason: 'checks-failing' };
    expect(draftUndecided(base)).toBe(true);
    expect(draftUndecided({ ...base, draftDecided: true })).toBe(false);
    expect(draftUndecided({ ...base, reason: 'checks-failing, draft-kept-tag-made' })).toBe(false);
    expect(draftUndecided({ ...base, draftId: undefined })).toBe(false);
    expect(draftUndecided({ ...base, status: 'uncertain' })).toBe(false);
    expect(draftUndecided({ ...base, action: 'comment' })).toBe(false);
  });

  it('an undecided row is not removed with its request; decided, it is', () => {
    const { store, id } = refusedUndecided();
    store.remove(id);
    expect(store.get(id)).not.toBeNull();
    expect(store.decideDraft(id)).toMatchObject({ draftDecided: true, reason: 'checks-failing' });
    store.remove(id);
    expect(store.get(id)).toBeNull();
  });

  it('the sweep decides a draft a quit left undecided: deleted, the reason unchanged, journaled', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    const { ex, emitted } = executor(store, gh);
    await ex.reconcileAll();
    expect(gh.releases).toEqual([]);
    expect(new ActEffectStore(file).get(id)).toMatchObject({ status: 'refused', reason: 'checks-failing', draftDecided: true });
    expect(emitted.at(-1)).toMatchObject({ status: 'refused', reason: 'checks-failing', draftDecided: true });
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
    expect(new ActEffectStore(file).get(id)).toMatchObject({ reason: 'checks-failing, draft-kept-tag-made', draftDecided: true });
    expect(emitted.at(-1)).toMatchObject({ reason: 'checks-failing, draft-kept-tag-made' });
  });

  it('a row whose request is gone is decided from its draft\'s own tag, then dropped', async () => {
    const { store, id } = refusedUndecided();
    const gh = github();
    const { ex, lines } = executor(store, gh, true);
    await ex.reconcileAll();
    expect(gh.releases).toEqual([]);
    expect(store.get(id)).toBeNull();
    expect(lines.some((l) => /draft 50: deleted/.test(l))).toBe(true);
  });
});
