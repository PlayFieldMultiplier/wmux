// The daemon builds its LanLinkServer without a network-category override, so
// production reads the real category (readNetCategory). An injected reader there
// would bypass the listen gate, as the old default did.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('daemon LanLinkServer wiring', () => {
  it('passes no netCategory override when it constructs the server', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    const start = src.indexOf('new LanLinkServer({');
    expect(start).toBeGreaterThan(-1);
    expect(src.indexOf('new LanLinkServer({', start + 1)).toBe(-1);
    const end = src.indexOf('\n  });', start);
    expect(end).toBeGreaterThan(start);
    const literal = src.slice(start, end);
    expect(literal).not.toMatch(/\bnetCategory\b/);
    expect(literal).toMatch(/\bonStatusChange\b/);
  });
});
