// What a packaged wmux must never ship: the fake agents the e2e scenarios put
// on PATH (scripts/fixtures/fake-agents). They answer as Claude Code and Codex
// 9.9.9, so a shipped copy could stand in for a user's real agent.
// Pure: entries and fixtures come from the caller (scripts/check-release-bundle.mjs).

export const FAKE_AGENT_DIR = 'scripts/fixtures/fake-agents';

const segments = (p) => p.split(/[\\/!]+/).filter(Boolean);

/**
 * The shipped entries that are a fake agent: any path inside a `fake-agents`
 * directory, or a file whose name and bytes are exactly a fixture's (a copy
 * that lost its directory). `entries` are `{ path, read }`, `read` giving the
 * file's bytes (or null when it cannot be read); `fixtures` maps a fixture's
 * file name to its bytes.
 */
export function shippedFakeAgents(entries, fixtures) {
  const found = [];
  for (const entry of entries) {
    const parts = segments(entry.path);
    if (parts.some((s) => s.toLowerCase() === 'fake-agents')) {
      found.push(entry.path);
      continue;
    }
    const fixture = fixtures.get(parts[parts.length - 1] ?? '');
    if (!fixture) continue;
    const bytes = entry.read();
    if (bytes && Buffer.compare(Buffer.from(bytes), fixture) === 0) found.push(entry.path);
  }
  return found;
}
