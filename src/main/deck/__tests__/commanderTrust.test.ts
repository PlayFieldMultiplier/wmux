// Unit tests for the commander trust registry (P3b codex P1, M1.5 ws-binding).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintCommanderToken,
  revokeCommanderToken,
  isCommanderToken,
  commanderTokenWorkspace,
  noteCommanderTokenUse,
  waitForCommanderTokenUse,
  __resetCommanderTrustForTesting,
} from '../commanderTrust';

describe('commanderTrust', () => {
  beforeEach(() => __resetCommanderTrustForTesting());

  it('a minted token verifies and carries its workspace; revocation kills it', () => {
    const token = mintCommanderToken('ws-1');
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(isCommanderToken(token)).toBe(true);
    expect(commanderTokenWorkspace(token)).toBe('ws-1');
    revokeCommanderToken(token);
    expect(isCommanderToken(token)).toBe(false);
    expect(commanderTokenWorkspace(token)).toBeNull();
  });

  it('rejects non-strings, empty strings, and unknown tokens', () => {
    mintCommanderToken('ws-1');
    expect(isCommanderToken(undefined)).toBe(false);
    expect(isCommanderToken(null)).toBe(false);
    expect(isCommanderToken('')).toBe(false);
    expect(isCommanderToken('not-a-real-token')).toBe(false);
    expect(isCommanderToken(42)).toBe(false);
    expect(commanderTokenWorkspace(undefined)).toBeNull();
    expect(commanderTokenWorkspace('not-a-real-token')).toBeNull();
  });

  it('tokens are independent — revoking one leaves the other live', () => {
    const a = mintCommanderToken('ws-a');
    const b = mintCommanderToken('ws-b');
    expect(a).not.toBe(b);
    revokeCommanderToken(a);
    expect(isCommanderToken(a)).toBe(false);
    expect(isCommanderToken(b)).toBe(true);
    expect(commanderTokenWorkspace(b)).toBe('ws-b');
  });

  it('an empty workspace binding registers but never resolves (fail closed)', () => {
    const token = mintCommanderToken('');
    expect(isCommanderToken(token)).toBe(true);
    expect(commanderTokenWorkspace(token)).toBeNull();
  });

  it('waits for a call carrying the token after a point in time, and gives up on revoke', async () => {
    const token = mintCommanderToken('ws-1');
    noteCommanderTokenUse(token, 100);
    // A use before `since` (an earlier MCP child) does not count.
    const waiting = waitForCommanderTokenUse(token, 200, 5_000);
    noteCommanderTokenUse(token, 250);
    await expect(waiting).resolves.toBe(true);
    await expect(waitForCommanderTokenUse(token, 240, 5_000)).resolves.toBe(true);
    const never = waitForCommanderTokenUse(token, 1_000, 5_000);
    revokeCommanderToken(token);
    await expect(never).resolves.toBe(false);
    // A revoked token's use is not recorded.
    noteCommanderTokenUse(token, 2_000);
    await expect(waitForCommanderTokenUse(token, 1_500, 10)).resolves.toBe(false);
  });
});
