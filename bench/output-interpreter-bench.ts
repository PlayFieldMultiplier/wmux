import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { OutputInterpreter } from '../src/daemon/OutputInterpreter';
import { loadNativeTerminalCore } from '../src/shared/nativeTerminalCore';

/** Same-process, alternating-order parser throughput only. This excludes PTY
 * delivery, renderer work, agent detection and real-team memory. */
export function benchmarkOutputInterpreter() {
  const core = loadNativeTerminalCore('output-interpreter-v1');
  assert(core.NativeOutputInterpreter && core.NativeOutputDecoder);
  const decoder = new core.NativeOutputDecoder();
  const results = [];
  for (const [workload, line] of [
    ['plain-log', 'PASS build src/example.ts 한글 😀 1234567890\r\n'],
    ['colored-log', '\x1b[32mPASS\x1b[0m build src/example.ts 한글 😀 1234567890\r\n'],
    ['mode-osc', '\x1b[?1049h\x1b[?2004h\x1b]7;file:///tmp/work\x07\x1b]133;C\x07한글 😀\x1b]133;D;0\x07\x1b[?1049l\r\n'],
  ]) {
    const text = line.repeat(Math.ceil(8192 / Buffer.byteLength(line)));
    const chunk = decoder.feed(Buffer.from(text), false);
    const rounds = Math.ceil(4 * 1024 * 1024 / chunk.byteLength);
    const samples: Array<{ backend: string; elapsedMs: number; cpuMs: number; events: number }> = [];
    try {
      for (let repeat = -1; repeat < 5; repeat++) {
        for (const backend of repeat % 2 === 0 ? ['node', 'rust'] : ['rust', 'node']) {
          const interpreter = new OutputInterpreter(backend as 'node' | 'rust');
          assert.equal(interpreter.backend, backend);
          let events = 0, end = 0;
          interpreter.onOsc(() => { events++; });
          const cpuStart = process.cpuUsage(), start = performance.now();
          for (let n = 0; n < rounds; n++) {
            end += chunk.byteLength;
            interpreter.feed(text, end, backend === 'rust' ? chunk : undefined);
          }
          const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
          interpreter.dispose();
          if (repeat >= 0) samples.push({ backend, elapsedMs, cpuMs:(cpu.user+cpu.system)/1000, events });
        }
      }
      assert(samples.every(s => s.events === samples[0].events));
      results.push({workload, bytes:rounds*chunk.byteLength, samples});
    } finally { chunk.dispose(); }
  }
  return {platform:process.platform, arch:process.arch, node:process.version,
    scope:'Parser microbenchmark; same process, one warm-up, five alternating-order repeats. No application-memory or interactive-latency claim.', results};
}
