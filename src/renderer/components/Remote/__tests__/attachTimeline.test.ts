import { describe, expect, it } from 'vitest';
import { AttachTimeline } from '../attachTimeline';

describe('AttachTimeline (#2101)', () => {
  it('stamps each step with the ms since its run started', () => {
    let now = 1_000;
    const t = new AttachTimeline(() => now);
    const run = t.start('epoch=1 session=ab12cd34');
    now += 40;
    t.note(run, 'attach-sent');
    now += 5;
    t.note(run, 'ok');
    expect(t.describe()).toBe('#1 epoch=1 session=ab12cd34 [start@0 attach-sent@40 ok@45]');
    expect(t.age(run)).toBe(45);
  });

  it('keeps the newest runs only, oldest first', () => {
    const t = new AttachTimeline(() => 0, 2);
    t.start('a');
    t.start('b');
    const third = t.start('c');
    t.note(third, 'cancelled');
    expect(t.describe()).toBe('#2 b [start@0] | #3 c [start@0 cancelled@0]');
  });

  it('ignores steps of a run it no longer keeps', () => {
    const t = new AttachTimeline(() => 0, 1);
    const first = t.start('a');
    t.start('b');
    t.note(first, 'ok');
    expect(t.describe()).toBe('#2 b [start@0]');
    expect(t.age(first)).toBe(-1);
  });
});
