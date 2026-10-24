// Every character the POSIX path guard lets through must reach a real shell
// as part of one word, unchanged, inside the quotes the guard adds.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { remoteUploadPathText } from '../remoteUpload';

const NAME = 'photo-2026-10-24T01-02-03-456Z-0123abcd.png';
const ALLOWED = 'AZaz09_-./ +@%,=~';

describe.skipIf(process.platform === 'win32')('remoteUploadPathText in /bin/sh', () => {
  it('each allowed character round-trips as exactly one shell word', () => {
    for (const c of ALLOWED) {
      const hostPath = `/tmp/x${c}y/uploads/phone/${NAME}`;
      const typed = remoteUploadPathText(hostPath, { hostPlatform: 'linux' });
      expect(typed.ok).toBe(true);
      if (!typed.ok) continue;
      const out = execFileSync('/bin/sh', ['-c', `set -- ${typed.text}; printf '%s\\n%s' "$#" "$1"`], { encoding: 'utf8' });
      expect(out).toBe(`1\n${hostPath}`);
    }
  });
});
