/**
 * `wmux doctor detect --stats [--since <dur>] [--grace <dur>] [--sample <n>] [--json]`
 *
 * Reports how often the screen detector disagreed with the hook, from the
 * daemon's opt-in detection agreement log (`diagnostics.detectionAgreement` in
 * the daemon config; see daemon/diagnostics/detectionAgreementLog.ts). Reads
 * the local files only: no daemon, no app, no network.
 *
 * Testability: argument parsing and rendering are pure; `handleDoctorDetect`
 * only wires the file reads and the clock.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getWmuxHomeDir } from '../../shared/constants';
import {
  DEFAULT_DETECTION_GRACE_MS,
  analyzeDetectionRecords,
  detectionErrorRate,
  parseDetectionLog,
  type DetectionReport,
} from '../../shared/detectionAgreement';

export const DETECTION_LOG_FILE = 'detection.ndjson';

export interface DoctorDetectOptions {
  /** Epoch ms; undefined counts the whole log. */
  since?: number;
  graceMs: number;
  sample: number;
}

const USAGE = 'usage: wmux doctor detect --stats [--since 7d] [--grace 5s] [--sample 20] [--json]';

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `1500ms`, `5s`, `30m`, `12h`, `7d` → ms. Null for anything else. */
export function parseDurationMs(raw: string): number | null {
  const m = DURATION_RE.exec(raw.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * UNIT_MS[m[2]]);
}

export function parseDoctorDetectArgs(
  args: string[],
  now: number,
): { ok: true; opts: DoctorDetectOptions } | { ok: false; error: string } {
  if (!args.includes('--stats')) return { ok: false, error: USAGE };
  const opts: DoctorDetectOptions = { graceMs: DEFAULT_DETECTION_GRACE_MS, sample: 0 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--stats') continue;
    // Anything else unknown (`--since=7d` included) is an error, not a silent full-log report.
    if (flag !== '--since' && flag !== '--grace' && flag !== '--sample') {
      return { ok: false, error: `unknown argument: ${flag}\n${USAGE}` };
    }
    const value = args[i + 1];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    i++;
    if (flag === '--sample') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: '--sample takes a whole number' };
      opts.sample = n;
      continue;
    }
    const ms = parseDurationMs(value);
    if (ms === null) return { ok: false, error: `${flag} takes a duration like 5s, 30m, 12h or 7d` };
    if (flag === '--since') opts.since = now - ms;
    else opts.graceMs = ms;
  }
  return { ok: true, opts };
}

function pct(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

function isoDate(t: number | null): string {
  return t === null ? '-' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

/** Pad every column to its widest cell. */
function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows
    .map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '))
    .join('\n');
}

export function formatDetectionReport(report: DetectionReport, sample: number): string {
  const lines: string[] = [];
  const apps = report.apps.length > 0 ? report.apps.join(', ') : 'unknown';
  lines.push(
    `detection agreement  ${isoDate(report.from)} → ${isoDate(report.to)} UTC  grace ${report.graceMs}ms  app ${apps}`,
  );
  const agents = Object.keys(report.agents).sort();
  if (agents.length === 0) {
    lines.push('', 'No measured panes yet. Run an agent with wmux hooks installed and submit a prompt.');
  } else {
    const rows: string[][] = [[
      'agent', 'reads', 'edges', 'false-idle', 'false-busy', 'false-await', 'missed-idle', 'missed-await', 'error-rate', 'leaked', 'held',
    ]];
    for (const agent of agents) {
      const st = report.agents[agent];
      rows.push([
        agent,
        String(st.reads),
        String(st.hookEdges),
        String(st.falseIdle),
        String(st.falseBusy),
        String(st.falseAwaiting),
        String(st.missedIdle),
        String(st.missedAwaiting),
        pct(detectionErrorRate(st)),
        String(st.leaked),
        String(st.held),
      ]);
    }
    lines.push('', table(rows));
    lines.push('leaked: false reads that reached the screen · held: false reads held for confirmation, shown unless rebutted');
    lines.push('');
    for (const agent of agents) {
      const st = report.agents[agent];
      const off = st.offsetMs;
      const notes = [
        `agree ${st.agree}`,
        `early ${st.early}`,
        `unconfirmed-await ${st.unconfirmedAwaiting}`,
        off.count > 0 ? `offset p50 ${off.p50}ms p95 ${off.p95}ms (detector first ${off.led}/${off.count})` : 'offset -',
      ];
      if (st.noTruth > 0) notes.push(`no-truth ${st.noTruth}`);
      if (st.provisionalStops > 0) notes.push(`provisional-stops ${st.provisionalStops}`);
      lines.push(`${agent}: ${notes.join(' · ')}`);
      const rules = Object.entries(st.falseByRule).sort((x, y) => y[1] - x[1]).slice(0, 5);
      if (rules.length > 0) lines.push(`  top false rules: ${rules.map(([r, n]) => `"${r}" ${n}`).join(' · ')}`);
    }
  }
  const skipped = report.skipped;
  const skippedTotal = skipped.brain + skipped['inexact-routing'] + skipped['no-turn-start'];
  if (skippedTotal > 0) {
    lines.push(
      '',
      `never measured: ${skippedTotal} pane(s) (no prompt-submit hook ${skipped['no-turn-start']}, `
        + `inexact hook routing ${skipped['inexact-routing']}, deck brain ${skipped.brain})`,
    );
  }
  if (sample > 0 && report.samples.length > 0) {
    lines.push('', `latest ${report.samples.length} error(s):`);
    for (const s of report.samples) {
      const read = s.read ? ` read=${s.read} hook=${s.truth}` : '';
      const extra = `${s.rule ? ` rule="${s.rule}"` : ''}${s.decision ? ` decision=${s.decision}` : ''}`;
      lines.push(`  ${new Date(s.t).toISOString()}  ${s.a}  ${s.s}  ${s.outcome}${read}${extra}`);
    }
  }
  return lines.join('\n');
}

/** The log and its rotated predecessor, oldest first. Missing files are skipped. */
export function readDetectionLogText(dir: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const parts: string[] = [];
  for (const name of [`${DETECTION_LOG_FILE}.1`, DETECTION_LOG_FILE]) {
    try {
      parts.push(read(join(dir, name)));
    } catch {
      // Absent or unreadable: the other file may still exist.
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export async function handleDoctorDetect(args: string[], jsonMode: boolean): Promise<void> {
  const parsed = parseDoctorDetectArgs(args, Date.now());
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const home = getWmuxHomeDir();
  const dir = join(home, 'diagnostics');
  const text = readDetectionLogText(dir);
  if (text === null) {
    const msg = `No detection agreement log in ${dir}.\n`
      + `Turn it on with "diagnostics": { "detectionAgreement": true } in ${join(home, 'config.json')}, then restart wmux.`;
    if (jsonMode) console.log(JSON.stringify({ error: 'no-log', dir }, null, 2));
    else console.error(msg);
    process.exit(1);
  }
  const report = analyzeDetectionRecords(parseDetectionLog(text), {
    graceMs: parsed.opts.graceMs,
    ...(parsed.opts.since !== undefined ? { since: parsed.opts.since } : {}),
    sampleLimit: parsed.opts.sample,
  });
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDetectionReport(report, parsed.opts.sample));
}
