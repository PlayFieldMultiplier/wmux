// The Git page's review guide is trusted only for a PR Moa delivered from this
// computer: a local delivery record for the URL, same repo (not a fork), and
// authored by this computer's gh account. The body's marker is never trust.
import { describe, it, expect, vi } from 'vitest';
import { GhPrService } from '../GhPrService';
import { REVIEW_GUIDE_MARKER, type ReviewGuide } from '../../../shared/prReviewGuide';

const URL = 'https://github.com/o/r/pull/9';
const guide: ReviewGuide = { steps: [{ target: 'criteria', items: ['(1) x'] }], gate: 'passed', headSha: 'a'.repeat(40) };

function svcFor(view: Record<string, unknown>, viewer = 'owner', delivered = true) {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ number: 9, url: URL, comments: [], reviews: [], ...view }) };
    if (args[0] === 'api' && args[1] === 'user') return { stdout: `${viewer}\n` };
    if (args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] } } } } }) };
    return { stdout: '[]' };
  });
  const svc = new GhPrService(() => 1000, exec as never);
  svc.setMoaReviewGuideLookup((u) => (delivered && u === URL ? guide : null));
  return svc;
}

const body = `Delivered by Moa\n\n${REVIEW_GUIDE_MARKER}\n### Review order\n1. **What you asked for** — x`;

describe('GhPrService review guide trust', () => {
  it('a delivered, same-repo PR by this account gets the guide from the record', async () => {
    const d = await svcFor({ body, author: { login: 'Owner' }, isCrossRepository: false }).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toEqual(guide);
    expect(d.ok && d.detail.reviewGuideUnverified).toBeFalsy();
  });

  it('a fork PR carrying the marker is unverified, even with a matching record', async () => {
    const d = await svcFor({ body, author: { login: 'owner' }, isCrossRepository: true }).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBe(true);
  });

  it('another author is unverified', async () => {
    const d = await svcFor({ body, author: { login: 'mallory' }, isCrossRepository: false }).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBe(true);
  });

  it('a spoofed marker with no delivery record is unverified', async () => {
    const d = await svcFor({ body, author: { login: 'owner' }, isCrossRepository: false }, 'owner', false).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBe(true);
  });

  it('no marker and no record: neither a guide nor a warning', async () => {
    const d = await svcFor({ body: 'plain', author: { login: 'x' }, isCrossRepository: false }, 'owner', false).prDetail('/r', 9, 'T');
    expect(d.ok && d.detail.reviewGuide).toBeUndefined();
    expect(d.ok && d.detail.reviewGuideUnverified).toBeFalsy();
  });
});
