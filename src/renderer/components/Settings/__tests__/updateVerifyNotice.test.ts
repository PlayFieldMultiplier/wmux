import { describe, expect, it } from 'vitest';
import { verifyFailedAfterAvailable, verifyFailedAfterNotice, verifyFailedDisplayVersion } from '../updateVerifyNotice';

describe('verifyFailedAfterAvailable', () => {
  it('keeps the line when the feed re-announces the same release in its tag spelling', () => {
    // getNotice / verify-failed carry the manifest form, UPDATE_AVAILABLE the feed's tag.
    expect(verifyFailedAfterAvailable('3.5.0', { status: 'available', releaseName: 'v3.5.0' })).toBe('3.5.0');
    expect(verifyFailedAfterAvailable('3.5.0', { status: 'available' })).toBe('3.5.0');
  });

  it('clears it for another release, or once this one downloaded and verified', () => {
    expect(verifyFailedAfterAvailable('3.5.0', { status: 'available', releaseName: 'v3.5.1' })).toBeNull();
    expect(verifyFailedAfterAvailable('3.5.0', { status: 'downloaded', releaseName: 'v3.5.0' })).toBeNull();
  });

  it('stays empty when there is no line', () => {
    expect(verifyFailedAfterAvailable(null, { status: 'available', releaseName: 'v3.5.0' })).toBeNull();
  });
});

describe('verifyFailedDisplayVersion', () => {
  it('shows one spelling whichever source it came from', () => {
    expect(verifyFailedDisplayVersion('v3.5.0')).toBe('3.5.0');
    expect(verifyFailedDisplayVersion('3.5.0')).toBe('3.5.0');
  });
});

describe('verifyFailedAfterNotice', () => {
  it('a reply that lands after a live event for a newer release does not bring the line back', () => {
    // Mount: the request goes out with no events seen. A failure for 3.5.0 is
    // on record, but 3.5.1 is announced before the reply arrives.
    const requestedAt = 0;
    let line: string | null = null;
    let events = 0;
    events++;
    line = verifyFailedAfterAvailable(line, { status: 'available', releaseName: 'v3.5.1' });
    line = verifyFailedAfterNotice(line, '3.5.0', requestedAt, events);
    expect(line).toBeNull();
  });

  it('a reply with no event in between applies', () => {
    expect(verifyFailedAfterNotice(null, '3.5.0', 0, 0)).toBe('3.5.0');
    expect(verifyFailedAfterNotice(null, 'v3.5.0', 2, 2)).toBe('3.5.0');
    expect(verifyFailedAfterNotice(null, null, 0, 0)).toBeNull();
  });

  it('a line a live event already set is kept', () => {
    expect(verifyFailedAfterNotice('3.5.0', null, 0, 1)).toBe('3.5.0');
  });
});
