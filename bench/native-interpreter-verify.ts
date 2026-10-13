import assert from 'node:assert/strict';
import { OscParser, type OscEvent } from '../src/main/pty/OscParser';
import { OutputModeTracker } from '../src/daemon/util/outputModeTracker';
import { loadNativeTerminalCore } from '../src/shared/nativeTerminalCore';
import { OutputInterpreter } from '../src/daemon/OutputInterpreter';
import { DaemonPTYBridge } from '../src/daemon/DaemonPTYBridge';
import { RingBuffer } from '../src/daemon/RingBuffer';
import { PromptEventLog } from '../src/daemon/PromptEventLog';
import type { NativeOutputChunk } from '../src/shared/nativeTerminalCore';
import type { TerminalPty } from '../src/shared/terminalPty';

const modes = [1, 7, 25, 47, 1047, 1049, 1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004, 999];
export function verifyOutputInterpreter(): string[] {
  const native = loadNativeTerminalCore('output-interpreter-v1');
  assert(native.NativeOutputInterpreter && native.NativeOutputDecoder);
  let feeds = 0;
  function compare(chunks: string[], prefill = '', offset = 0): void {
    const referenceModes = new OutputModeTracker(), referenceOsc = new OscParser();
    const interpreter = new OutputInterpreter('rust');
    assert.equal(interpreter.backend, 'rust');
    const expected: OscEvent[] = [], actual: OscEvent[] = [];
    referenceOsc.onOsc(e => expected.push(e)); interpreter.onOsc(e => actual.push(e));
    if (prefill) {
      offset += Buffer.byteLength(prefill);
      referenceModes.feed(prefill, offset); interpreter.seedModes(prefill, offset);
      assert.deepEqual(actual, []);
    }
    try {
      for (const text of chunks) {
        offset += Buffer.byteLength(text);
        referenceModes.feed(text, offset); referenceOsc.process(text);
        interpreter.feed(text, offset);
        assert.deepEqual(actual, expected, `OSC parity at feed ${feeds}`);
        actual.length = expected.length = 0;
        assert.equal(interpreter.modes.altScreen, referenceModes.altScreen);
        for (const mode of modes) assert.equal(interpreter.modes.isSet(mode), referenceModes.isSet(mode), `mode ${mode}`);
        for (const start of [0, 1, offset - 512, offset - 256, offset - 32, offset - 1, offset, offset + 1, Number.MAX_SAFE_INTEGER]) {
          assert.equal(interpreter.modes.preamble(start), referenceModes.preamble(start), `preamble offset ${start} feed ${feeds}`);
        }
        feeds++;
      }
    } finally { interpreter.dispose(); }
  }
  const stream = '한글 😀\x1b[?1049h\x1b[?7;25l\x1b]7;file:///tmp/한글\x07' +
    '\x1b]133;A\x07$ \x1b]133;B\x07\x1b]133;C\x1b\\work\x1b]133;D;7\x07' +
    '\x1b[?1006;2004h\x1b[!p\x1b]2;title\x07\x1b]777;notify;title;body\x1b\\\x1bc';
  // Chunk at every code-point boundary. These preserve the current JS parser's
  // semantics; split OSC introducers/ST are a documented reference limitation.
  const points = Array.from(stream);
  for (let split = 0; split <= points.length; split++) compare([points.slice(0, split).join(''), points.slice(split).join('')]);
  compare(points, '', 2 ** 33);
  compare(['x', '\x1b[?47l', '\x1b[?1049l'], '\x1b[?47;1049h\x1b]133;C\x07', 8192);
  compare(['\x1b]7;' + '😀'.repeat(32768), '\x07', '\x1b]133;D\x07']);
  compare(['\x1b]7;' + 'x'.repeat(65534), '\x07', '\x1b]7;' + 'x'.repeat(65535), '\x07']);
  compare(['\x1b]  +007x;/tmp\x07\x1b]abc;ignored\x07\x1b]-0;negative-zero\x07\x1b]\uFEFF99;notice\x07']);
  compare(['😀\x1b[?1049h' + 'x'.repeat(247), 'tail', '\x1b[?1049l'], '', 2 ** 33);
  compare(['x'.repeat(255) + '😀', '\x1b[?00001049h', 'x'.repeat(300), '\x1b[!p', '\x1bc']);
  let seed = 0x5eed;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const pieces = ['hello', '한글😀', '\x1b[?1049h', '\x1b[?1049l', '\x1bc', '\x1b[!p', '\x1b[?7;25l',
    '\x1b[?1006;2004h', '\x1b]7;file:///tmp\x07', '\x1b]133;C\x07', '\x1b]133;D;0\x1b\\', '\x1b[?1047h', '\x1b[?47l'];
  const chunks: string[] = [];
  for (let n = 0; n < 2000; n++) {
    const p = Array.from(pieces[random(pieces.length)] + pieces[random(pieces.length)]);
    const split = random(p.length + 1);
    chunks.push(p.slice(0, split).join(''), p.slice(split).join(''));
  }
  compare(chunks, '', 2 ** 33);

  // Real N-API chunk input and bridge policy: analysis occurs only after a ring
  // write; muted output is ignored or replayed exactly once, with the same OSC
  // ordering and prompt offsets as the JS host.
  function bridge(backend: 'node' | 'rust') {
    let output: ((chunk: NativeOutputChunk) => void) | undefined;
    const decoder = new native.NativeOutputDecoder!();
    const pty = {backend, onNativeData: (cb: typeof output) => {output=cb;return {dispose(){output=undefined;}};},
      onExit: () => ({dispose(){ /* no child in bridge-policy fixture */ }}), write(){ /* no query in fixture */ }} as unknown as TerminalPty;
    const ring = new RingBuffer(65536, backend);
    ring.write(Buffer.from('\x1b[?1049h\x1b]133;C\x07'));
    const instance = new DaemonPTYBridge(), promptLog = new PromptEventLog();
    const events: unknown[] = [];
    for (const name of ['cwd', 'title', 'prompt', 'notification', 'data']) instance.on(name, value => {
      events.push({name, ...(name === 'data' ? {data:value.toString()} : {value:JSON.parse(JSON.stringify(value, (key, v) => key === 'ts' ? 0 : v))})});
    });
    instance.setupDataForwarding(pty, ring, 'interpreter-parity', promptLog);
    return {instance, ring, promptLog, events, feed(text: string) {
      const chunk = decoder.feed(Buffer.from(text), false);
      try { output?.(chunk); } finally { chunk.dispose(); }
    }, close(){instance.cleanup();ring.dispose();}};
  }
  const reference = bridge('node'), actual = bridge('rust');
  try {
    for (const h of [reference, actual]) {
      assert.equal(h.promptLog.size, 0);
      assert.equal(h.instance.outputModes?.altScreen, true);
      h.instance.setMuted(true);
      h.feed('\x1b[?1049l\x1b]133;C\x07discard');
      assert.equal(h.promptLog.size, 0);
      assert.equal(h.instance.outputModes?.altScreen, true);
      h.instance.setMuted(false);
      h.instance.setMuted(true);
      h.feed('\x1b[?1049l\x1b]7;file:///tmp/test\x07\x1b]133;A\x07held');
      assert.equal(h.promptLog.size, 0);
      h.instance.setMuted(false, {replayHeld:true});
      h.instance.setMuted(false, {replayHeld:true});
      h.feed('\x1b]2;title\x07\x1b]133;B\x07\x1b]133;C\x07output\x1b]133;D;7\x07');
      h.feed('\x1b]777;notify;build;finished\x07\x1b[?2004h');
    }
    assert.deepEqual(actual.events, reference.events);
    assert.deepEqual(actual.ring.readAll(), reference.ring.readAll());
    assert.equal(actual.promptLog.size, 4);
    assert.equal(actual.instance.outputModes?.preamble(Number.MAX_SAFE_INTEGER), reference.instance.outputModes?.preamble(Number.MAX_SAFE_INTEGER));
  } finally {actual.close();reference.close();}
  const disposed = new native.NativeOutputInterpreter(); disposed.dispose();
  assert.throws(() => disposed.feed('late', 4, true), /disposed/);
  assert.throws(() => disposed.preamble(4), /disposed/);
  const invalid = new native.NativeOutputInterpreter();
  for (const offset of [-1, NaN, Infinity, 0.5, 2 ** 53]) {
    assert.throws(() => invalid.feed('\x1b[?1049h', offset, true), /offset/);
    assert.equal(invalid.altScreen, false);
  }
  invalid.dispose();
  return [`output interpreter: ${feeds} differential feeds (OSC/modes/preamble, seeded splits, Unicode and >4 GiB offsets)`,
    'output interpreter: native chunks, recovered mode seeding, mute/discard/replay, prompt/event order and disposal'];
}
