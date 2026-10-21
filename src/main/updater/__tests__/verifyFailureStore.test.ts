import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearVerifyFailure,
  readVerifyFailure,
  verifyFailurePath,
  writeVerifyFailure,
} from '../verifyFailureStore';

describe('verifyFailureStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-verify-failure-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a record and clears it', () => {
    const file = verifyFailurePath(dir);
    const record = { version: '4.9.0', sha256: 'ab'.repeat(32) };
    expect(readVerifyFailure(file)).toBeNull();

    writeVerifyFailure(file, record);
    expect(readVerifyFailure(file)).toEqual(record);

    clearVerifyFailure(file);
    expect(readVerifyFailure(file)).toBeNull();
    expect(() => clearVerifyFailure(file)).not.toThrow();
  });

  it('reads a malformed file as no record', () => {
    const file = verifyFailurePath(dir);
    for (const body of ['nope', '{}', '{"version":"4.9.0","sha256":"short"}', '{"version":4,"sha256":"' + 'a'.repeat(64) + '"}']) {
      fs.writeFileSync(file, body);
      expect(readVerifyFailure(file), body).toBeNull();
    }
  });
});
