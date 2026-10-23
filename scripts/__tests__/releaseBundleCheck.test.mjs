// The release bundle check (scripts/check-release-bundle.mjs): a packaged
// wmux must not ship the e2e fake agents.
// @wmux-lane unit
import { describe, expect, it } from 'vitest';
import { indexFixtures, shippedFakeAgents } from '../lib/release-bundle-check-lib.mjs';

const index = indexFixtures(new Map([
  ['claude.mjs', Buffer.from('fake claude 9.9.9')],
  ['fakeAgentCli.mjs', Buffer.from('fake cli')],
]));
const file = (p, bytes, size) => ({
  path: p,
  ...(size === undefined ? (bytes === null ? {} : { size: Buffer.byteLength(bytes) }) : { size }),
  read: () => (bytes === null ? null : Buffer.from(bytes)),
});

describe('shippedFakeAgents', () => {
  it('finds a fake agent inside a fake-agents directory, in an archive or beside it, in any case', () => {
    expect(shippedFakeAgents([
      file('out/wmux.app/Contents/Resources/app.asar!/scripts/fixtures/fake-agents/codex.mjs', 'x'),
      file('out\\wmux-win32-x64\\resources\\Fake-Agents\\README', 'y'),
    ], index).found).toEqual([
      'out/wmux.app/Contents/Resources/app.asar!/scripts/fixtures/fake-agents/codex.mjs',
      'out\\wmux-win32-x64\\resources\\Fake-Agents\\README',
    ]);
  });

  it('finds a fixture copied anywhere by its bytes: under its own name, another name, or another case', () => {
    expect(shippedFakeAgents([
      file('out/resources/app.asar!/.vite/build/fakeAgentCli.mjs', 'fake cli'),
      file('out/resources/app.asar!/.vite/build/chunk-3f2a.js', 'fake cli'),
      file('out/resources/app.asar!/bin/Claude.mjs', 'fake claude 9.9.9'),
    ], index).found).toEqual([
      'out/resources/app.asar!/.vite/build/fakeAgentCli.mjs',
      'out/resources/app.asar!/.vite/build/chunk-3f2a.js',
      'out/resources/app.asar!/bin/Claude.mjs',
    ]);
  });

  it('a file named like a fixture (any case) that cannot be read is reported, not passed', () => {
    const result = shippedFakeAgents([
      file('out/resources/app.asar!/claude.mjs', null),
      file('out/resources/app.asar!/CLAUDE.MJS', null, 3),
      file('out/resources/app.asar!/bin/FAKEAGENTCLI.MJS', null, 3),
    ], index);
    expect(result.found).toEqual([]);
    expect(result.unreadable).toEqual([
      'out/resources/app.asar!/claude.mjs',
      'out/resources/app.asar!/CLAUDE.MJS',
      'out/resources/app.asar!/bin/FAKEAGENTCLI.MJS',
    ]);
  });

  it('a real file that shares a fixture\'s name, and files of another size, are clean and not read', () => {
    let reads = 0;
    const counted = (p, bytes) => ({ path: p, size: Buffer.byteLength(bytes), read: () => { reads++; return Buffer.from(bytes); } });
    const result = shippedFakeAgents([
      file('out/resources/app.asar!/node_modules/x/claude.mjs', 'a real module'),
      counted('out/resources/app.asar!/.vite/build/index.js', 'the app, some size'),
      counted('out/resources/daemon-bundle/index.js', 'the daemon'),
    ], index);
    expect(result).toEqual({ found: [], unreadable: [] });
    expect(reads).toBe(0);
  });
});
