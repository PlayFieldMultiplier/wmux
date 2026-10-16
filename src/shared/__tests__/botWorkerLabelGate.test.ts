// The label gate run as Claude Code runs it: the script under node with the
// PreToolUse input on stdin (exit 0 passes, exit 2 refuses), and the rules
// read the way Claude Code reads a `Bash(<pattern>)` rule.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BOT_WORKER_LABEL_ALLOW, BOT_WORKER_LABEL_GATE_SCRIPT, BOT_WORKER_PR_EDIT_DENY, BOT_WORKER_PR_EDIT_FLAG_DENY, labelGateHookCommand, labelGateRules,
} from '../botWorkerLabelGate';
import { BOT_WORKER_DENY, buildBotWorkerSettings } from '../botWorkerGuard';
import { buildWorkerSettings } from '../botWorkerMcp';

function matches(command: string, rules: readonly string[]): boolean {
  return rules.some((rule) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const re = new RegExp(`^${m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(command);
  });
}

let dir: string;
let script: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-label-gate-'));
  script = path.join(dir, 'gate.cjs');
  fs.writeFileSync(script, BOT_WORKER_LABEL_GATE_SCRIPT);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function gate(command: unknown, input?: string): number | null {
  const r = spawnSync(process.execPath, [script], { input: input ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  return r.status;
}

const STRICT = labelGateRules(BOT_WORKER_DENY, '/data/factory/worker-gate/0123456789ab.cjs')!;

const ALLOWED = [
  'gh pr edit 2272 --add-label by-wmux-bot',
  'gh pr edit 2272 --remove-label by-wmux-bot',
  'gh pr edit 2272 --add-label by-wmux-bot --remove-label needs-triage',
  'gh pr edit 3 --remove-label a --add-label b,c --add-label d',
  'gh pr edit 3 --add-label=by-wmux-bot',
  'gh pr edit 3 --add-label "good first issue"',
  "gh pr edit 3 --add-label 'by-wmux-bot'",
  'gh pr edit 3 --add-label="area: docs,v2.0"',
  '  gh pr edit 3 --add-label x  ',
];

const REFUSED = [
  'gh pr edit 3 --add-label x --title y',
  'gh pr edit 3 --title y --add-label x',
  'gh pr edit 3 --add-label x -t y',
  'gh pr edit 3 --add-label x --body y',
  'gh pr edit 3 --add-label x --body-file b.md',
  'gh pr edit 3 --add-label x --base main',
  'gh pr edit 3 --add-label x --add-reviewer someone',
  'gh pr edit 3 --add-label x --add-assignee someone',
  'gh pr edit 3 --add-label x --milestone v1',
  'gh pr edit 3 --add-label x --some-future-flag',
  'gh pr edit 3 --add-label x -R other/repo',
  'gh -R other/repo pr edit 3 --add-label x',
  'gh pr edit 3',
  'gh pr edit --add-label x',
  'gh pr edit 3 --title y',
  // Chained, compound, substituted, redirected.
  'gh pr edit 3 --add-label x; gh pr merge 1',
  'gh pr edit 3 --add-label x && gh pr merge',
  'gh pr edit 3 --add-label x || gh pr merge 1',
  'gh pr edit 3 --add-label x | sh',
  'gh pr edit 3 --add-label x & gh pr merge 1',
  'gh pr edit 3 --add-label "$(gh pr merge 1)"',
  'gh pr edit 3 --add-label $(gh pr merge 1)',
  'gh pr edit 3 --add-label `gh pr merge 1`',
  'gh pr edit 3 --add-label x > out.txt',
  'gh pr edit 3 --add-label x<in',
  'gh pr edit 3 --add-label x\ngh pr merge 1',
  'gh pr edit 3 --add-label $LABEL',
  'gh pr edit 3 --add-label "${LABEL}"',
  'echo hi && gh pr edit 3 --title y',
  'true; gh pr edit 3 --add-label x',
  '(gh pr edit 3 --add-label x)',
  // Quoted, escaped and Windows spellings of the same command.
  'gh pr "edit" 3 --title y',
  "gh 'pr' edit 3 --title y",
  'gh pr ed\\it 3 --title y',
  'gh.exe pr edit 3 --title y',
  '/usr/bin/gh pr edit 3 --title y',
  'C:\\Program Files\\GitHub CLI\\gh.exe pr edit 3 --title y',
  // cmd's quoting: none of its escapes or expansions pass.
  'gh pr edit 3 --add-label x ^& gh pr merge 1',
  'gh pr edit 3 --add-label %LABEL%',
  'gh pr edit 3 --add-label !LABEL!',
  'gh pr edit 3 --add-label x\r\ngh pr merge 1',
  'gh pr edit 3 --add-label "x" & gh pr merge 1',
  'gh pr edit 3 --add-label "x\\" --title y"',
];

describe('the gh pr edit gate script', () => {
  it.each(ALLOWED)('passes %s', (cmd) => {
    expect(gate(cmd)).toBe(0);
  });

  it.each(REFUSED)('refuses %s', (cmd) => {
    expect(gate(cmd)).toBe(2);
  });

  it.each([
    'gh pr view 3 --json title',
    'gh pr create --title x --body y --label by-wmux-bot',
    'git commit -m "edit the pr template"',
    'gh pr list --json title | grep edit',
    'npm test',
  ])('has no opinion on %s', (cmd) => {
    expect(gate(cmd)).toBe(0);
  });

  it('refuses what it cannot read', () => {
    expect(gate(undefined, '{not json')).toBe(2);
    expect(gate(undefined, JSON.stringify({ tool_input: {} }))).toBe(2);
    expect(gate(42)).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('the hook line refuses every command when the script cannot run', () => {
    const run = (file: string) => spawnSync('/bin/sh', ['-c', labelGateHookCommand(file)], {
      input: JSON.stringify({ tool_input: { command: 'npm test' } }),
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` },
    }).status;
    expect(run(script)).toBe(0);
    expect(run(path.join(dir, 'missing.cjs'))).toBe(2);
  });
});

describe('the rules a gated launch carries', () => {
  it('trades the blanket gh pr edit deny for the flag denies, the label allows and the hook', () => {
    expect(BOT_WORKER_PR_EDIT_DENY.every((r) => BOT_WORKER_DENY.includes(r))).toBe(true);
    expect(STRICT.deny.some((r) => BOT_WORKER_PR_EDIT_DENY.includes(r))).toBe(false);
    expect(STRICT.deny).toEqual([...BOT_WORKER_DENY.filter((r) => !BOT_WORKER_PR_EDIT_DENY.includes(r)), ...BOT_WORKER_PR_EDIT_FLAG_DENY]);
    expect(STRICT.allow).toEqual([...BOT_WORKER_LABEL_ALLOW]);
    expect(STRICT.hook).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/data/factory/worker-gate/0123456789ab.cjs" || exit 2', timeout: 10 }] });
  });

  it('the rule set is pinned: any change to a rule is a deliberate change to this test', () => {
    expect(STRICT.deny.length).toBe(BOT_WORKER_DENY.length - 6 + 18);
    expect(createHash('sha256').update(JSON.stringify([...STRICT.deny, ...STRICT.allow])).digest('hex'))
      .toBe('6495522fd92336b47f00ea0dbf6ea2f5c532f56dd0fac344006a1413081979cb');
  });

  it.each(ALLOWED.slice(0, 7))('the label form %s meets no deny rule and an allow rule', (cmd) => {
    expect(matches(cmd, STRICT.deny)).toBe(false);
    expect(matches(cmd, STRICT.allow)).toBe(true);
  });

  it.each([
    'gh pr edit 3 --add-label x --title y',
    'gh pr edit 3 --add-label x --title=y',
    'gh pr edit 3 --add-label x -ty',
    'gh pr edit 3 --add-label x --body-file b.md',
    'gh pr edit 3 --add-label x -F b.md',
    'gh pr edit 3 --add-label x --base main',
    'gh pr edit 3 --add-label x --add-reviewer someone',
    'gh pr edit 3 --add-label x --remove-assignee someone',
    'gh pr edit 3 --add-label x --milestone v1',
    'gh -R o/r pr edit 3 --title y',
    'gh pr -R o/r edit 3 --title y',
  ])('without hooks, the flag denies still refuse %s, which the allow pattern may match', (cmd) => {
    expect(matches(cmd, STRICT.deny)).toBe(true);
  });

  it.each([
    'gh pr merge 1',
    'gh pr merge 3 --squash',
    'gh -R o/r pr merge 3',
    'gh api -X POST repos/o/r/issues',
    'gh api --method PATCH repos/o/r/pulls/3',
    'gh api repos/o/r/issues -f title=x',
    'git push origin main',
    'git push origin wtask/a',
  ])('everything else stays refused: %s', (cmd) => {
    expect(matches(cmd, STRICT.deny)).toBe(true);
  });

  it('gh pr create with labels was never refused', () => {
    expect(matches('gh pr create --title x --body y --label by-wmux-bot', BOT_WORKER_DENY)).toBe(false);
    expect(matches('gh pr create --title x --body y --label by-wmux-bot', STRICT.deny)).toBe(false);
  });

  it('a script path that cannot sit in a hook line keeps the blanket deny', () => {
    for (const bad of ['/data/fac"tory/g.cjs', '/data/$HOME/g.cjs', 'C:\\\\data\\g.cjs', '/data/%X%/g.cjs']) expect(labelGateRules(BOT_WORKER_DENY, bad)).toBeNull();
  });

  it('every settings document without the blanket gh pr edit deny carries the gate hook', () => {
    const docs = [
      buildBotWorkerSettings(),
      buildWorkerSettings([]),
      buildWorkerSettings([], undefined, '/data/factory/worker-gate/0123456789ab.cjs'),
      buildWorkerSettings([], undefined, '/data/fac"tory/g.cjs'),
    ] as Array<{ permissions: { deny: string[] }; hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>;
    for (const doc of docs) {
      const blanket = BOT_WORKER_PR_EDIT_DENY.every((r) => doc.permissions.deny.includes(r));
      const hooked = (doc.hooks?.PreToolUse ?? []).some((g) => g.matcher === 'Bash' && g.hooks.some((h) => h.command.endsWith('.cjs" || exit 2')));
      expect(blanket || hooked).toBe(true);
    }
    // The WSL pane's file keeps the blanket deny.
    expect(BOT_WORKER_PR_EDIT_DENY.every((r) => (buildBotWorkerSettings() as { permissions: { deny: string[] } }).permissions.deny.includes(r))).toBe(true);
  });

  it('a gated launch forces hooks on and keeps the connections\' hooks', () => {
    const s = buildWorkerSettings([], undefined, '/data/factory/worker-gate/0123456789ab.cjs') as Record<string, unknown>;
    expect(s.disableAllHooks).toBe(false);
    expect(s.permissions).toEqual({ allow: [...BOT_WORKER_LABEL_ALLOW], deny: STRICT.deny });
    expect(s.hooks).toEqual({ PreToolUse: [STRICT.hook] });
  });
});
