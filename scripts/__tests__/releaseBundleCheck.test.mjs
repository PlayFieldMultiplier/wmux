// The release bundle check (scripts/check-release-bundle.mjs): a packaged
// wmux must never ship the e2e fake agents.
// @wmux-lane unit
import { describe, expect, it } from 'vitest';
import { shippedFakeAgents } from '../lib/release-bundle-check-lib.mjs';

const fixtures = new Map([
  ['claude.mjs', Buffer.from('fake claude 9.9.9')],
  ['fakeAgentCli.mjs', Buffer.from('fake cli')],
]);
const file = (p, bytes) => ({ path: p, read: () => (bytes === null ? null : Buffer.from(bytes)) });

describe('shippedFakeAgents', () => {
  it('finds a fake agent inside a fake-agents directory, in an archive or beside it', () => {
    expect(shippedFakeAgents([
      file('out/wmux.app/Contents/Resources/app.asar!/scripts/fixtures/fake-agents/codex.mjs', 'x'),
      file('out\\wmux-win32-x64\\resources\\fake-agents\\README', 'y'),
    ], fixtures)).toEqual([
      'out/wmux.app/Contents/Resources/app.asar!/scripts/fixtures/fake-agents/codex.mjs',
      'out\\wmux-win32-x64\\resources\\fake-agents\\README',
    ]);
  });

  it('finds a fixture copied anywhere under its own name, by its bytes', () => {
    expect(shippedFakeAgents([file('out/resources/app.asar!/.vite/build/fakeAgentCli.mjs', 'fake cli')], fixtures))
      .toEqual(['out/resources/app.asar!/.vite/build/fakeAgentCli.mjs']);
  });

  it('a real file that shares a fixture\'s name, an unreadable one, and the rest are clean', () => {
    expect(shippedFakeAgents([
      file('out/resources/app.asar!/node_modules/x/claude.mjs', 'a real module'),
      file('out/resources/app.asar!/claude.mjs', null),
      file('out/resources/app.asar!/.vite/build/index.js', 'app'),
      file('out/resources/daemon-bundle/index.js', 'daemon'),
    ], fixtures)).toEqual([]);
  });
});
