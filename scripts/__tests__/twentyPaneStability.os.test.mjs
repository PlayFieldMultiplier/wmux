// Measurement core of the 20-pane stability soak (scripts/twenty-pane-stability.mjs).
// The driver needs a packaged app; these cover what turns raw samples into the
// published numbers, and the marker matcher the renderer hook embeds.
import { describe, expect, it } from 'vitest';
import {
  linearSlope, markerFor, parseArgs, pickStreaming, planLayout, producerCommand,
  producerSource, stripTerminalControls, summarizeRun,
} from '../lib/twenty-pane-stability.mjs';

const MiB = 1024 * 1024;

function sample(tSec, over = {}) {
  return {
    tSec,
    keyboard: [{ phase: 'afterSwitch', echoMs: 4, frameMs: 12 }, { phase: 'steady', echoMs: 2, frameMs: 10 }],
    probes: [
      { ptyId: 'a', cls: 'streaming', echoMs: 6 },
      { ptyId: 'b', cls: 'idle', echoMs: 3 },
    ],
    stalls: [],
    silent: [],
    raf: { p50: 16.7, throttled: false },
    focus: { workspaceSwitch: false, focused: true },
    memory: { daemonRssBytes: 100 * MiB + tSec * MiB, electronBytes: 500 * MiB },
    ...over,
  };
}

describe('twenty-pane stability summary', () => {
  it('counts lost markers as drops, separates late echoes, and keeps latency stats to echoed ones', () => {
    const samples = [
      sample(0),
      sample(10, {
        keyboard: [{ phase: 'afterSwitch', echoMs: null, frameMs: null }, { phase: 'steady', echoMs: 40, frameMs: 50 }],
        probes: [{ ptyId: 'a', cls: 'streaming', echoMs: null }, { ptyId: 'b', cls: 'idle', echoMs: 5 }],
        late: [{ kind: 'probe', lateMs: 4200 }],
      }),
    ];
    const s = summarizeRun(samples);
    expect(s.keyboard.sent).toBe(4);
    expect(s.keyboard.dropped).toBe(1);
    expect(s.keyboard.echoMs.max).toBe(40);
    expect(s.keyboard.afterSwitch.dropped).toBe(1);
    expect(s.keyboard.steady.echoMs.count).toBe(2);
    expect(s.probes.streaming.dropped).toBe(1);
    expect(s.probes.idle.echoMs.max).toBe(5);
    expect(s.probes.late).toEqual({ count: 1, maxMs: 4200 });
    expect(s.probes.perPane.find((p) => p.ptyId === 'a')).toMatchObject({ sent: 2, dropped: 1 });
    expect(s.flags.join('\n')).toMatch(/1 focused keystroke marker/);
    expect(s.flags.join('\n')).toMatch(/1 pane probe\(s\) not echoed within the timeout \(1 arrived later\)/);
  });

  it('reports stalls and panes still silent at the end', () => {
    const samples = [
      sample(0, { stalls: [{ ptyId: 'a', cls: 'streaming', gapMs: 7000, atSec: 3 }] }),
      sample(10, { stalls: [{ ptyId: 'a', cls: 'streaming', gapMs: 9000, atSec: 12 }], silent: [{ ptyId: 'c', cls: 'streaming', silentMs: 8000 }] }),
    ];
    const s = summarizeRun(samples, { stallMs: 5000 });
    expect(s.stalls).toMatchObject({ thresholdMs: 5000, episodes: 2, panes: 1, worstGapMs: 9000 });
    expect(s.stalls.silentAtEnd).toHaveLength(1);
    expect(s.flags.some((f) => f.includes('silent at the last sample'))).toBe(true);
  });

  it('turns memory samples into a growth rate per hour', () => {
    // daemon grows 1 MiB per second -> 3600 MiB/h; Electron flat.
    const s = summarizeRun([sample(0), sample(300), sample(600)]);
    expect(s.memory.daemonRss).toMatchObject({ firstMiB: 100, lastMiB: 700, maxMiB: 700, growthMiBPerHour: 3600 });
    expect(s.memory.electronTotal.growthMiBPerHour).toBe(0);
    expect(s.memory.processTree).toBeNull();
    // A short run reports levels but no rate.
    expect(summarizeRun([sample(0), sample(60)]).memory.daemonRss.growthMiBPerHour).toBeNull();
  });

  it('buckets samples into 5-minute windows', () => {
    const samples = [sample(0), sample(299), sample(300), sample(610)];
    const s = summarizeRun(samples);
    expect(s.windows.map((w) => w.fromMin)).toEqual([0, 5, 10]);
    expect(s.windows[0].keyboardP95Ms).toBe(4);
  });

  it('flags throttled windows and focus misses without failing the run', () => {
    const s = summarizeRun([sample(0, { raf: { p50: 100, throttled: true }, focus: { workspaceSwitch: true, focused: false } })]);
    expect(s.frames.throttledSamples).toBe(1);
    expect(s.focus).toEqual({ workspaceSwitches: 1, focusMisses: 1 });
    expect(s.flags).toHaveLength(2);
  });

  it('fits a least-squares slope', () => {
    expect(linearSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toBe(2);
    expect(linearSlope([{ x: 1, y: 1 }])).toBeNull();
  });
});

describe('twenty-pane stability marker matching', () => {
  it('finds a marker through PSReadLine-style colour, cursor moves and chunk re-renders', () => {
    const m = markerFor(7, 42);
    const echoed = `\x1b[?25l\x1b[93mqz7\x1b[0m\x1b[?25h\x1b[3G\x1b[93m${m}\x1b[0m\r\n`;
    expect(stripTerminalControls(echoed)).toContain(m);
    // OSC title/cwd reports and DECSC/DECRC (the producer's repaint) are stripped too.
    expect(stripTerminalControls(`\x1b]0;title\x07\x1b7\x1b[1;1Hx\x1b8${m}`)).toBe(`x${m}`);
  });

  it('never appears in producer output, and markers are unique', () => {
    expect(producerSource()).not.toMatch(/qz/);
    expect(markerFor(1, 11)).not.toBe(markerFor(11, 1));
  });

  it('runs as a self-contained function, as the renderer hook embeds it', () => {
    const rebuilt = new Function(`return (${stripTerminalControls.toString()})`)();
    expect(rebuilt('\x1b[31mqz1k1j\x1b[0m')).toBe('qz1k1j');
  });
});

describe('twenty-pane stability setup helpers', () => {
  it('parses flags with defaults', () => {
    expect(parseArgs([])).toMatchObject({ minutes: 30, panes: 20, streaming: 6, perWorkspace: 5 });
    expect(parseArgs(['--panes', '4', '--minutes', '1', '--streaming', '1'])).toMatchObject({ panes: 4, minutes: 1, streaming: 1 });
    expect(() => parseArgs(['--streaming', '9', '--panes', '4'])).toThrow(/cannot exceed/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });

  it('lays panes out per workspace and spreads streaming panes across workspaces', () => {
    expect(planLayout(20, 5)).toEqual([5, 5, 5, 5]);
    expect(planLayout(7, 5)).toEqual([5, 2]);
    const panes = planLayout(20, 5).flatMap((n, w) => Array.from({ length: n }, (_, i) => ({ workspaceIndex: w, indexInWorkspace: i })));
    const picked = [...pickStreaming(panes, 6)].map((pos) => panes[pos]);
    expect(new Set(picked.map((p) => p.workspaceIndex)).size).toBe(4);
  });

  it('quotes the producer command for PowerShell and POSIX shells', () => {
    expect(producerCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', "C:\\T\\it's.cjs", [3, 16, 60]))
      .toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\T\\it''s.cjs' 3 16 60");
    expect(producerCommand('darwin', '/usr/local/bin/node', "/tmp/it's.cjs", [0, 16, 60]))
      .toBe("'/usr/local/bin/node' '/tmp/it'\\''s.cjs' 0 16 60");
  });
});
