// The real Windows read: the PowerShell script runs against this machine's own
// addresses and answers with one of the four categories.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { categoryScript, parseCategoryOutput, readNetCategory, QUERY_TIMEOUT_MS } from '../netCategory';

function firstExternalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

describe.runIf(process.platform === 'win32')('readNetCategory on Windows', () => {
  it('reads a category for a live external address', async () => {
    const ip = firstExternalIPv4();
    if (!ip) return; // a runner with no external IPv4 has nothing to read
    await expect(readNetCategory(ip)).resolves.toMatch(/^(Private|Public|Domain|Unknown)$/);
  }, 20_000);

  it('rejects for an address this machine does not have', async () => {
    await expect(readNetCategory('203.0.113.250')).rejects.toThrow();
  }, 20_000);
});

describe.runIf(process.platform !== 'win32')('readNetCategory elsewhere', () => {
  it('is not-applicable', async () => {
    await expect(readNetCategory('192.168.1.10')).resolves.toBe('not-applicable');
  });
});

describe.runIf(process.platform === 'win32')('Windows PowerShell 5.1 output bytes', () => {
  it('writes the category line to a pipe as single-byte ASCII, not UTF-16', async () => {
    const ip = firstExternalIPv4();
    if (!ip) return;
    const psPath = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      execFile(psPath, ['-NoProfile', '-NonInteractive', '-Command', categoryScript(ip)], { encoding: 'buffer', windowsHide: true, timeout: QUERY_TIMEOUT_MS }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    });
    expect(stdout.includes(0)).toBe(false); // UTF-16LE would interleave NUL bytes
    expect(parseCategoryOutput(stdout.toString('utf-8'))).toMatch(/^(Private|Public|Domain|Unknown)$/);
  }, 20_000);
});
