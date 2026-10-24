/**
 * A file dropped on another PC's pane (a `remote-terminal` mirror) is not
 * typed there: the path names a file on this machine. The drop used to end
 * without a word; it must tell the person instead.
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

  it('says it is not supported yet instead of returning silently', () => {
    const region = dropRegion();
    expect(region).toMatch(
      /if \(activeSurface\.surfaceType === 'remote-terminal'\) \{\s*state\.pushToast\(\{ level: 'info', message: translate\('remote\.mirror\.dropUnsupported'\) \}\);\s*return;/,
    );
    // Not folded back into the silent PTY-less early return.
    expect(region).not.toMatch(/surfaceType === 'diff' \|\| activeSurface\.surfaceType === 'remote-terminal'\) return;/);
  });
});
