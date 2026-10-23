// What a packaged wmux must never ship: the fake agents the e2e scenarios put
// on PATH (scripts/fixtures/fake-agents). They answer as Claude Code and Codex
// 9.9.9, so a shipped copy could stand in for a user's real agent.
// Pure: entries and fixtures come from the caller (scripts/check-release-bundle.mjs).
import { createHash } from 'node:crypto';

export const FAKE_AGENT_DIR = 'scripts/fixtures/fake-agents';

const segments = (p) => p.split(/[\\/!]+/).filter(Boolean);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Each fixture's size and hash, hashed once, and its name (lowercased). `fixtures` maps a file name to its bytes. */
export function indexFixtures(fixtures) {
  const index = { sizes: new Set(), hashes: new Set(), names: new Set() };
  for (const [name, bytes] of fixtures) {
    index.sizes.add(bytes.length);
    index.hashes.add(sha256(bytes));
    index.names.add(name.toLowerCase());
  }
  return index;
}

/** Whether a path alone marks a fake agent's place: a `fake-agents` segment, or a fixture's name (any case). */
export function pathNamesFakeAgent(p, index) {
  const parts = segments(p);
  return parts.some((s) => s.toLowerCase() === 'fake-agents') || index.names.has((parts[parts.length - 1] ?? '').toLowerCase());
}

/**
 * The shipped entries that are a fake agent, and the ones that could be but
 * cannot be read. `entries` are `{ path, size?, read }`: `read` gives the
 * file's bytes, or null when it cannot be read.
 *
 * - Any path inside a `fake-agents` directory (any case) is one.
 * - Any file with a fixture's bytes is one, whatever it is called: its size
 *   picks it out (an entry with no size is read), its hash decides.
 * - A file named like a fixture (any case) is always read, so one that cannot
 *   be read is reported, never passed as clean.
 */
export function shippedFakeAgents(entries, index) {
  const found = [];
  const unreadable = [];
  for (const entry of entries) {
    const parts = segments(entry.path);
    if (parts.some((s) => s.toLowerCase() === 'fake-agents')) {
      found.push(entry.path);
      continue;
    }
    const named = index.names.has((parts[parts.length - 1] ?? '').toLowerCase());
    const sized = typeof entry.size !== 'number' || index.sizes.has(entry.size);
    if (!named && !sized) continue;
    let bytes = null;
    try { bytes = entry.read(); } catch { bytes = null; }
    if (!bytes) {
      unreadable.push(entry.path);
      continue;
    }
    const buf = Buffer.from(bytes);
    if (index.sizes.has(buf.length) && index.hashes.has(sha256(buf))) found.push(entry.path);
  }
  return { found, unreadable };
}
