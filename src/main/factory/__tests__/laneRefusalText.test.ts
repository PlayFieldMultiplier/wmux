// A lane refusal in the owner's words: each known code is a sentence, never
// the raw code; unknown codes share one sentence, prose stays prose.

import { describe, expect, it } from 'vitest';
import { UNKNOWN_REFUSAL_SENTENCE, formatLaneRefusal, laneRefusalCodes, laneRefusalLine, laneRefusalSentence } from '../laneRefusalText';

describe('laneRefusalText', () => {
  it('reads every reason shape the lane writes', () => {
    expect(laneRefusalCodes('required-checks-green:no-required-checks, author-trusted:external-author')).toEqual(['required-checks-green:no-required-checks', 'author-trusted:external-author']);
    expect(laneRefusalCodes('lane-paused')).toEqual(['lane-paused']);
    expect(laneRefusalCodes('repro-origin: a repro worker opened this PR from an issue; the owner merges it')).toEqual(['repro-origin']);
    // Prose with commas is one part, never split into fake codes.
    expect(laneRefusalCodes('something odd, with commas')).toEqual(['something odd, with commas']);
    expect(laneRefusalCodes('  ')).toEqual([]);
  });

  it('a reason is read under its predicate first', () => {
    expect(laneRefusalSentence('not-release-pr:package-manifest')).toBe('It changes package.json or package-lock.json');
    expect(laneRefusalSentence('gate-definition-changed:package-manifest')).toBe('It changes package.json, which defines the gate');
    expect(laneRefusalSentence('author-trusted:external-author')).toBe('The author isn\'t trusted');
    expect(laneRefusalSentence('required-checks-green:required-check-fail')).toBe('A required check did not pass');
    expect(laneRefusalSentence('blocked-draft')).toBe('GitHub blocked the merge');
    expect(laneRefusalSentence('identity-changed')).toBe('The GitHub login changed since the check');
    // A GitLab repo's sentences name GitLab.
    expect(laneRefusalSentence('identity-changed', 'gitlab.example.com/group/app')).toBe('The GitLab login changed since the check');
    expect(laneRefusalSentence('blocked-draft', 'gitlab.example.com/group/app')).toBe('GitLab blocked the merge');
    expect(laneRefusalLine('checks-truncated', 'github.com/acme/app')).toBe('GitHub listed too many checks to read them all');
    expect(laneRefusalSentence('nobody-knows')).toBeNull();
    // Only the table's own entries count, never an object's inherited names.
    expect(laneRefusalSentence('constructor')).toBeNull();
    expect(laneRefusalSentence('author-trusted:__proto__')).toBeNull();
    expect(formatLaneRefusal('constructor')).toBe(`- ${UNKNOWN_REFUSAL_SENTENCE}`);
  });

  it('formats one bullet per sentence and never shows a raw code', () => {
    expect(formatLaneRefusal('repro-origin: a repro worker opened this PR from an issue; the owner merges it'))
      .toBe('- A repro worker opened it from an issue, so you merge it');
    expect(formatLaneRefusal('lane-daily-cap')).toBe('- Today\'s lane merge limit is reached');
    expect(formatLaneRefusal('nobody-knows, also-unknown')).toBe(`- ${UNKNOWN_REFUSAL_SENTENCE}`);
    expect(formatLaneRefusal('')).toBe('');
    // Prose is already words.
    expect(formatLaneRefusal('started from outside text')).toBe('- started from outside text');
  });

  it('laneRefusalLine is one line of sentences (approval views and bot notices)', () => {
    expect(laneRefusalLine('head-moved')).toBe('The PR\'s head moved after it was checked');
    expect(laneRefusalLine('required-checks-green:no-required-checks, not-release-pr:no-files, weird:x'))
      .toBe(`The repository has no required checks; GitHub listed no changed files; ${UNKNOWN_REFUSAL_SENTENCE}`);
    expect(laneRefusalLine('only merges are carried out by a rule')).toBe('only merges are carried out by a rule');
    expect(laneRefusalLine('')).toBe('');
  });
});
