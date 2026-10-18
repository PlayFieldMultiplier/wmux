import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

/**
 * #2398 (GLM P2) — a reconcile pass confirms, at its end, the unconfirmed
 * bindings it looked at. It awaits several RPCs first, and a reattach that
 * runs out meanwhile marks its id again; a confirm that ignored that later
 * mark let the pane clear and self-create beside a live session. A mark made
 * after the pass started must win.
 */
describe('setPtysUnconfirmed mark generations', () => {
  beforeEach(() => {
    useStore.setState({ ptyUnconfirmedById: {}, ptyUnconfirmedSeq: 0 });
  });

  it('a confirm bounded by the pass start keeps a mark made after it', () => {
    const s = () => useStore.getState();
    s().setPtysUnconfirmed(['before', 'remarked'], true);
    const passStart = s().ptyUnconfirmedSeq;
    s().setPtysUnconfirmed(['remarked', 'after'], true);
    s().setPtysUnconfirmed(['before', 'remarked', 'after'], false, { markedAtOrBefore: passStart });
    expect(Object.keys(s().ptyUnconfirmedById).sort()).toEqual(['after', 'remarked']);
  });

  it('an unbounded confirm clears every mark it names', () => {
    const s = () => useStore.getState();
    s().setPtysUnconfirmed(['a', 'b'], true);
    s().setPtysUnconfirmed(['a', 'b', 'never-marked'], false);
    expect(s().ptyUnconfirmedById).toEqual({});
  });
});
