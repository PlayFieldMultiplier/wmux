// Chat sends, Stop and Rewind are a person's input typed by the bridge; they
// already stop at any dialog on screen. These pin that the measured
// folder-trust dialogs are among them, so none of their writes answers one.
import { describe, expect, it } from 'vitest';
import { screenBlocksChatSend } from '../chatScreenGate';
import { trustFixtureRows } from '../../../test-utils/folderTrustSessions';

describe('screenBlocksChatSend at a folder-trust dialog', () => {
  it.each([
    'claude-folder-trust-120x40',
    'claude-folder-trust-60x30',
    'codex-folder-trust-120x40',
    'codex-folder-trust-60x30',
    'codex-folder-trust-22x30',
  ])('blocks %s', (name) => {
    expect(screenBlocksChatSend(trustFixtureRows(name))).toBe(true);
  });
});
