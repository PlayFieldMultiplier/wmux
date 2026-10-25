// GhActService against a real child process standing in for gh: a write's
// text travels as JSON on stdin, never in argv, so `@x` (gh's `-F` file
// read) and `{owner}` (its placeholder) arrive byte for byte; 4xx, a rate
// limit and an unstartable gh are told apart.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhActService, httpStatusOf } from '../GhActService';
import { GhRateBreaker } from '../ghRateBreaker';

let dir = '';
let script = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fake-gh-'));
  script = path.join(dir, 'fake-gh.cjs');
  // Records its argv and stdin; answers by the endpoint.
  fs.writeFileSync(script, `
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input, cwd: process.cwd() }));
  const endpoint = args.find((a) => a.startsWith('repos/') || a === 'user');
  if (endpoint === 'repos/o/r/issues/404') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  if (endpoint === 'repos/o/r/issues/429') { process.stderr.write('gh: API rate limit exceeded (HTTP 403)\\n'); process.exit(1); }
  if (endpoint === 'repos/o/r/issues/500') { process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ echoed: input ? JSON.parse(input) : null }));
});
`);
});
afterEach(() => {
  delete process.env.FAKE_GH_LOG;
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(): { gh: GhActService; log: () => { args: string[]; input: string; cwd: string } } {
  const logFile = path.join(dir, 'log.json');
  process.env.FAKE_GH_LOG = logFile;
  const gh = new GhActService(() => dir, { file: process.execPath, prefix: [script] }, new GhRateBreaker());
  return { gh, log: () => JSON.parse(fs.readFileSync(logFile, 'utf8')) as { args: string[]; input: string; cwd: string } };
}

describe('GhActService (a stand-in gh process)', () => {
  it('sends a write\'s body as JSON on stdin: @x and {owner} arrive as written, and argv holds no text', async () => {
    const { gh, log } = service();
    const body = 'see @x and {owner}/{repo} -F body=@/etc/passwd "quoted" \\ back\nline 2 ```';
    const a = await gh.write('github.com', 'POST', 'repos/o/r/issues/1/comments', { body });
    expect(a).toEqual({ ok: true, value: { echoed: { body } } });
    const seen = log();
    expect(seen.args).toEqual(['api', '--hostname', 'github.com', '-X', 'POST', 'repos/o/r/issues/1/comments', '--input', '-']);
    expect(JSON.parse(seen.input)).toEqual({ body });
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
  });

  it('tells a 4xx (nothing written), a rate limit and a 5xx (may have been written) apart, and refuses an endpoint it did not build', async () => {
    const { gh } = service();
    expect(await gh.read('github.com', 'repos/o/r/issues/404')).toMatchObject({ ok: false, kind: 'http', status: 404 });
    expect(await gh.write('github.com', 'PATCH', 'repos/o/r/issues/429', { state: 'closed' })).toMatchObject({ ok: false, kind: 'rate-limited' });
    // The breaker is open now: nothing is started for that host.
    expect(await gh.read('github.com', 'repos/o/r/issues/1')).toMatchObject({ ok: false, kind: 'rate-limited' });
    const fresh = service().gh;
    expect(await fresh.write('github.com', 'PATCH', 'repos/o/r/issues/500', { state: 'closed' })).toMatchObject({ ok: false, kind: 'error' });
    expect(await fresh.read('github.com', 'repos/o/r --jq .x')).toMatchObject({ ok: false, kind: 'unsent' });
  });

  it('reads the HTTP status gh reports', () => {
    expect(httpStatusOf('gh: Validation Failed (HTTP 422)')).toBe(422);
    expect(httpStatusOf('connection reset')).toBeNull();
  });

  it('a gh that cannot be started sent nothing', async () => {
    const gh = new GhActService(() => dir, { file: path.join(dir, 'no-such-gh.exe'), prefix: [] }, new GhRateBreaker());
    expect(await gh.read('github.com', 'user')).toMatchObject({ ok: false, kind: 'unsent' });
  });
});
