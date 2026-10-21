import { describe, expect, it } from 'vitest';
import { verifyFailedAfterAvailable, verifyFailedDisplayVersion } from '../updateVerifyNotice';

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
