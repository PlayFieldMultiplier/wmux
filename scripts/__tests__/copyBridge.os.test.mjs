import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// [shipped name in dist/cli-bundle, source, the marker an installer looks for
// to call an installed copy wmux-owned (src/shared/lifecycleIntegrations.ts,
// hookFlavours.ts, openCodeTerminalChatIntegration.ts); null when the installer
// compares the copy byte for byte instead (installAgyQuotaSensor.ts)]
const BRIDGES = [
  ['wmux-opencode-plugin.js', 'integrations/opencode/plugins/wmux.js', 'wmux-managed: opencode-lifecycle-bridge'],
  ['wmux-codex-notify.mjs', 'integrations/codex/bin/wmux-codex-notify.mjs', 'wmux ↔ Codex CLI notify bridge'],
  ['wmux-codex-hooks-bridge.mjs', 'integrations/codex/bin/wmux-codex-hooks-bridge.mjs', 'wmux-managed: codex-hooks-bridge'],
  ['wmux-hooks-bridge.mjs', 'integrations/shared/bin/wmux-hooks-bridge.mjs', 'wmux-managed: shared-hooks-bridge'],
  ['wmux-codex-thread.mjs', 'integrations/codex/bin/wmux-codex-thread.mjs', 'wmux-managed: codex-thread-attribution'],
  ['wmux-chat-tui.mjs', 'integrations/opencode/plugins/wmux-chat-tui.mjs', 'wmux-managed: opencode-terminal-chat'],
  ['quota-sink.js', 'integrations/agy/bin/quota-sink.js', null],
];

describe('copy-bridge', () => {
  it('ships each bridge byte for byte, so the comment markers installers rely on survive', () => {
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'copy-bridge.mjs')], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    for (const [shipped, source, marker] of BRIDGES) {
      const copy = readFileSync(join(root, 'dist', 'cli-bundle', shipped));
      expect(copy.equals(readFileSync(join(root, source))), shipped).toBe(true);
      if (marker) expect(copy.toString('utf8'), shipped).toContain(marker);
    }
  });
});
