import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression test for the v2.9.0 cold-boot scrollback-loss race.
 *
 * Symptom (reported during v2.9.0-rc.1 dogfood, Windows reboot):
 *   After a system reboot, the auto-restarted wmux briefly showed an empty
 *   terminal area, then surfaced fresh PowerShell prompts in every pane —
 *   with the user's entire previous-session scrollback gone. Layout (5
 *   workspaces, 7-pane split) restored fine; only the per-surface text
 *   content was lost.
 *
 * Root cause:
 *   `app.on('ready')` of main process re-runs the IPC handler set after
 *   the daemon-connect path (`cleanupHandlers(); cleanupHandlers =
 *   registerAllHandlers(..., daemonClient)`). The cleanup tears down
 *   every channel the bundle returned, including `scrollback:load`,
 *   `scrollback:dump`, `session:load`, and `session:save`. The
 *   re-register call reinstalls them microseconds later, but during that
 *   gap any renderer-side `ipcRenderer.invoke('scrollback:load', ...)`
 *   rejects with "No handler registered." Under cold-boot timing
 *   (renderer slower than usual, useTerminal mass-mounts 11 surfaces at
 *   once), several invocations land in that gap. The silent `.catch`
 *   in `useTerminal.ts` swallows the rejection, the terminal registers
 *   without restored content, and 5 seconds later the periodic autosave
 *   dumps the empty buffer over the previous scrollback file on disk —
 *   destroying scrollback permanently.
 *
 * Fix:
 *   Move `registerSessionHandlers()` out of the `registerAllHandlers`
 *   swap cycle and install it ONCE at module load from `main/index.ts`.
 *   The session/scrollback handlers have zero dependency on `daemonClient`,
 *   so there is no reason for them to be part of the daemon-connect
 *   teardown. Same hardening pattern the v2.8.1 hotfix used to break the
 *   `daemon:get-ready-state` race (Bug 3).
 *
 * This regression test asserts the fix in a structural way: it scans
 * `registerHandlers.ts` and fails if `registerSessionHandlers` ever
 * sneaks back into the swap cycle (either via direct import or via a
 * call site). A behavioural test using a mocked `ipcMain` would also
 * work, but the structural shape of the bug is "the wrong function is
 * called from the wrong place" — checking the source directly catches
 * the regression with no plumbing.
 */
describe('registerAllHandlers race fix (v2.9.0 scrollback restore)', () => {
  const registerHandlersPath = path.join(__dirname, '..', 'registerHandlers.ts');
  const source = fs.readFileSync(registerHandlersPath, 'utf-8');

  it('does not import registerSessionHandlers (must live outside the swap cycle)', () => {
    // If this fires, a future change has reintroduced the cold-boot
    // scrollback-loss race. Move the offending registration back into
    // `main/index.ts` module-load instead.
    expect(source).not.toMatch(/from\s+['"]\.\/handlers\/session\.handler['"]/);
  });

  it('does not invoke registerSessionHandlers inside registerAllHandlers', () => {
    expect(source).not.toMatch(/registerSessionHandlers\s*\(/);
  });

  it('does not destructure session.handler exports anywhere', () => {
    // Defence against `import { registerSessionHandlers as X } from ...`
    // style rebrands.
    expect(source).not.toMatch(/['"]\.\/handlers\/session\.handler['"]/);
  });

  it('keeps connector consent and terminal leases outside daemon swaps', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');
    for (const service of ['OAuth', 'Terminal', 'Check', 'Catalog']) {
      const register = `registerConnector${service}Handlers`;
      expect(source).not.toContain(register);
      expect(main.match(new RegExp(`${register}\\(`, 'g'))).toHaveLength(1);
    }
    const quit = main.slice(main.indexOf("app.on('before-quit',"));
    for (const cleanup of ['cleanupConnectorChecks()', 'cleanupConnectorTerminal()', 'connectorOAuth.cleanup()', 'cleanupConnectorCatalog()']) {
      expect(source).not.toContain(cleanup);
      expect(main.match(new RegExp(cleanup.replace(/[().]/g, '\\$&'), 'g'))).toHaveLength(1);
      expect(quit).toContain(cleanup);
    }
  });
});
