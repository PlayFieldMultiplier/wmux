import { OscParser, type OscCallback } from '../main/pty/OscParser';
import { loadNativeTerminalCore, reportNativeFallback, type NativeOutputChunk, type NativeOutputInterpreter } from '../shared/nativeTerminalCore';
import { OutputModeTracker } from './util/outputModeTracker';

export type OutputModes = Pick<OutputModeTracker, 'isSet' | 'altScreen' | 'preamble' | 'reset'>;

/** One interpreter per bridge lifetime. Feed only captured output, after the
 * ring write. Recovered history seeds modes without replaying historical OSC
 * notifications or prompt events. Native capability is optional for ABI-1 builds. */
export class OutputInterpreter {
  readonly backend: 'node' | 'rust';
  readonly modes: OutputModes;
  private readonly native?: NativeOutputInterpreter;
  private readonly osc?: OscParser;
  private readonly jsModes?: OutputModeTracker;
  private readonly callbacks: OscCallback[] = [];

  constructor(backend: 'node' | 'rust') {
    if (backend === 'rust') {
      try {
        const Constructor = loadNativeTerminalCore('output-interpreter-v1').NativeOutputInterpreter;
        if (!Constructor) throw new Error('Missing native output interpreter');
        this.native = new Constructor();
      } catch { reportNativeFallback('output-interpreter'); }
    }
    this.backend = this.native ? 'rust' : 'node';
    if (this.native) this.modes = this.native;
    else {
      this.jsModes = new OutputModeTracker();
      this.modes = this.jsModes;
      this.osc = new OscParser();
    }
  }
  onOsc(callback: OscCallback): void {
    if (this.osc) this.osc.onOsc(callback);
    else this.callbacks.push(callback);
  }
  seedModes(text: string, end: number): void {
    if (this.native) this.native.feed(text, end, false);
    else this.jsModes?.feed(text, end);
  }
  feed(text: string, end: number, chunk?: NativeOutputChunk): void {
    if (this.native) {
      const events = chunk ? this.native.feedChunk(chunk, end) : this.native.feed(text, end, true);
      // As in the JS bridge, all mode updates precede OSC callbacks, and OSC
      // callbacks precede agent interpretation and raw output forwarding.
      if (events) for (let i = 0; i < events.codes.length; i++) {
        const event = { code: events.codes[i], data: events.data[i] };
        for (const callback of this.callbacks) callback(event);
      }
    } else {
      this.jsModes?.feed(text, end);
      this.osc?.process(text);
    }
  }
  dispose(): void {
    this.callbacks.length = 0;
    // An async screen render can hold `modes` across bridge cleanup. Preserve
    // its last state, just as the JS tracker does; the N-API finalizer reclaims
    // the interpreter when the final mode reference becomes unreachable.
  }
}
