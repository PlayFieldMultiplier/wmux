import { describe, expect, it } from 'vitest';
import {
  formatDetectionReport,
  parseDoctorDetectArgs,
  parseDurationMs,
  readDetectionLogText,
} from '../doctorDetect';
import { analyzeDetectionRecords, parseDetectionLog } from '../../../shared/detectionAgreement';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe('parseDurationMs', () => {
  it('reads the supported units', () => {
    expect(parseDurationMs('1500ms')).toBe(1500);
    expect(parseDurationMs('5s')).toBe(5_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
    expect(parseDurationMs('7 days')).toBeNull();
  });
});

describe('parseDoctorDetectArgs', () => {
  it('requires --stats', () => {
    expect(parseDoctorDetectArgs([], NOW).ok).toBe(false);
  });

  it('turns --since into an absolute time and --grace into ms', () => {
    const parsed = parseDoctorDetectArgs(['--stats', '--since', '1d', '--grace', '8s', '--sample', '3'], NOW);
    expect(parsed).toEqual({ ok: true, opts: { since: NOW - 86_400_000, graceMs: 8_000, sample: 3 } });
  });

  it('rejects a malformed value', () => {
    expect(parseDoctorDetectArgs(['--stats', '--grace', 'soon'], NOW).ok).toBe(false);
    expect(parseDoctorDetectArgs(['--stats', '--sample'], NOW).ok).toBe(false);
    expect(parseDoctorDetectArgs(['--stats', '--since=7d'], NOW).ok).toBe(false);
  });
});

describe('readDetectionLogText', () => {
  it('reads the rotated file first and skips missing files', () => {
    const files: Record<string, string> = { '/d/detection.ndjson.1': 'old', '/d/detection.ndjson': 'new' };
    const read = (p: string): string => {
      const v = files[p.replace(/\\/g, '/')];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    };
    expect(readDetectionLogText('/d', read)).toBe('old\nnew');
    expect(readDetectionLogText('/missing', read)).toBeNull();
  });
});

describe('formatDetectionReport', () => {
  it('prints one row per agent with the error rate and the top false rules', () => {
    const text = [
      { v: 1, type: 'start', t: NOW, app: '4.2.0', os: 'darwin' },
      { v: 1, t: NOW, s: 'p', a: 'claude', src: 'hook', h: 'busy', k: 'agent.user_prompt_submit' },
      { v: 1, t: NOW + 1_000, s: 'p', a: 'claude', src: 'det', st: 'waiting', d: 'veto', r: 'Ready for input' },
      { v: 1, t: NOW + 60_000, s: 'p', a: 'claude', src: 'hook', h: 'idle', k: 'agent.stop' },
      { v: 1, t: NOW + 61_000, s: 'p', a: 'claude', src: 'det', st: 'waiting', r: 'Ready for input' },
    ].map((r) => JSON.stringify(r)).join('\n');
    const report = analyzeDetectionRecords(parseDetectionLog(text), { sampleLimit: 5 });
    const out = formatDetectionReport(report, 5);
    expect(out).toContain('app 4.2.0');
    expect(out).toMatch(/claude\s+2\s+1\s+1\s+0\s+0\s+0\s+0\s+33\.3%\s+0\s+0/);
    expect(out).toContain('"Ready for input" 1');
    expect(out).toContain('false_idle read=waiting hook=busy');
  });

  it('never prints an API key from a log written before redaction, as text or JSON', () => {
    const key = `sk-ant-api03-${'x9Y8'.repeat(8)}`;
    const text = [
      { v: 1, type: 'start', t: NOW, app: '4.2.0', os: 'darwin' },
      { v: 1, t: NOW, s: 'p', a: 'claude', src: 'hook', h: 'busy', k: 'agent.user_prompt_submit' },
      { v: 1, t: NOW + 1_000, s: 'p', a: 'claude', src: 'det', st: 'waiting', d: 'veto', r: `key ${key}` },
      { v: 1, t: NOW + 60_000, s: 'p', a: 'claude', src: 'hook', h: 'idle', k: 'agent.stop' },
    ].map((r) => JSON.stringify(r)).join('\n');
    const report = analyzeDetectionRecords(parseDetectionLog(text), { sampleLimit: 5 });
    const out = formatDetectionReport(report, 5);
    expect(out).toContain('"key [redacted]" 1');
    expect(out).not.toContain(key);
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it('says so when nothing was measured', () => {
    const out = formatDetectionReport(analyzeDetectionRecords([]), 0);
    expect(out).toContain('No measured panes yet');
  });
});
