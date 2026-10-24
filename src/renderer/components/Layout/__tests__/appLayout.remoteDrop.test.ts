/**
 * A file dropped on another PC's pane (a `remote-terminal` mirror) is not
 * typed there as a local path: it goes to the mirror shown in that surface,
 * with preload's handle on the OS drop, and the mirror uploads it to the host. With no mirror mounted, the drop says so
 * instead of ending without a word.
 *
 * SOURCE-SCAN guard (house pattern: appLayout.stashAware): AppLayout's
 * onFileDrop handler has no jsdom fixture.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../../../test-utils/sourceText';

const source = readSourceText(path.join(__dirname, '..', 'AppLayout.tsx'));

describe('AppLayout — a drop on another PC\'s pane', () => {
  function dropRegion(): string {
    const start = source.indexOf('window.electronAPI.onFileDrop(');
    expect(start, 'onFileDrop handler not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('pastePtyChunked(', start);
    return source.slice(start, end > 0 ? end : start + 6000);
  }

  it('hands the drop to the mirror, and says so when none is mounted', () => {
    const region = dropRegion();
    expect(region).toMatch(
      /if \(activeSurface\.surfaceType === 'remote-terminal'\) \{\s*if \(!deliverMirrorDrop\(activeSurface\.id, registerDrop\)\) \{\s*showRemoteSendNotice\('not-connected'/,
    );
    // Not folded back into the silent PTY-less early return.
    expect(region).not.toMatch(/surfaceType === 'diff' \|\| activeSurface\.surfaceType === 'remote-terminal'\) return;/);
  });
});
