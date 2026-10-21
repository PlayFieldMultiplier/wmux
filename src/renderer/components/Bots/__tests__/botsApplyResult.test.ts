// Apply to my checkout's result line: the files written and how to undo
// them, or why nothing was written, in the reader's language.
import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import { applyResultText } from '../BotsChat';

describe('applyResultText', () => {
  it('names each file written, new and removed ones marked, and says git restore reverts it', () => {
    const text = applyResultText({ ok: true, changed: ['a.txt'], created: ['new/n.txt'], removed: ['gone.txt'] }, t);
    expect(text).toBe('Written to your checkout, unstaged: a.txt, new/n.txt (new), gone.txt (removed). git restore <file> reverts a changed or removed file; delete a new one to undo it.');
    expect(applyResultText({ ok: true, changed: ['a.txt'], created: [], removed: [] }, t)).toBe('Written to your checkout, unstaged: a.txt. git restore <file> reverts a file.');
  });

  it('lists the uncommitted files that stopped it, the first few then how many more', () => {
    const paths = ['1', '2', '3', '4', '5', '6', '7', '8'];
    expect(applyResultText({ ok: false, code: 'dirty', message: 'x', paths }, t))
      .toBe('Not applied: uncommitted changes in 1, 2, 3, 4, 5, 6 and 2 more. Commit or stash them first.');
    expect(applyResultText({ ok: false, code: 'foreign_head', message: 'The task branch does not start from its base.' }, t))
      .toBe('Not applied: The task branch does not start from its base.');
  });
});
