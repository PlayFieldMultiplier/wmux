import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #2398 x #2335 — the refused-create alert (#2398) and the daemon link notice
 * (#2335) both sit at the top of the pane, in the same place. As with the
 * recovery alert, the one that carries an action (Retry) wins; the link
 * notice, which only offers Dismiss, waits until it is gone.
 */
describe('Terminal.tsx — the refused-create alert wins over the link notice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Terminal.tsx'), 'utf-8');

  it('both alerts read one refused-create condition, gated on the surface binding', () => {
    expect(src).toMatch(/const createRefused = !externalPtyId && createAttempt\?\.state === 'createFailed';/);
    expect(src).toMatch(/\{createRefused && createAttempt\?\.state === 'createFailed' && \(/);
  });

  it('the link notice yields to the recovery and refused-create alerts', () => {
    expect(src).toMatch(/\{!recoveryError && !createRefused && linkNotice && ownerSurfaceId && <DaemonLinkNotice /);
  });
});
