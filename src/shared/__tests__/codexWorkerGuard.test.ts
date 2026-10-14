// The codex bot-worker guard's pure parts: the launch-line allowlist, the
// line main rebuilds, and the rules document. When a codex CLI is installed,
// the rules are also checked by Codex's own `execpolicy check`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_WORKER_JUSTIFICATION_PREFIX,
  buildCodexWorkerLaunchLine,
  buildCodexWorkerRules,
  codexVersionAtLeastFloor,
  namesCodex,
  parseCodexVersion,
  parseCodexWorkerLine,
} from '../codexWorkerGuard';
import { codexTrustOverride } from '../fanoutPreset';

const CWD = '/data/worktrees/abc/feat-x-1234';
const PROMPT = `"$(cat '/data/worktrees/.meta/feat-x-1234/prompt.md')"`;
const TRUST = codexTrustOverride(CWD, 'darwin')!;
const FANOUT_LINE = `codex ${TRUST} -a never -s workspace-write --model gpt-6.1-sol -c model_reasoning_effort=low ${PROMPT}`;

describe('the codex worker launch line: an allowlist', () => {
  it('accepts the fan-out line and keeps model, effort, tool level and prompt', () => {
    expect(parseCodexWorkerLine(FANOUT_LINE, CWD)).toEqual({ model: 'gpt-6.1-sol', effort: 'low', promptArgument: PROMPT });
    expect(parseCodexWorkerLine(`codex ${TRUST} ${PROMPT}`, CWD)).toEqual({ promptArgument: PROMPT });
    const tools = `codex ${TRUST} -c "mcp_servers.wmux.args=['/a/index.js','--core']" ${PROMPT}`;
    expect(parseCodexWorkerLine(tools, CWD)).toEqual({ wmuxTools: "mcp_servers.wmux.args=['/a/index.js','--core']", promptArgument: PROMPT });
  });

  it.each([
    ['a bypass flag', `codex ${TRUST} --yolo ${PROMPT}`],
    ['the bypass flag', `codex ${TRUST} --dangerously-bypass-approvals-and-sandbox ${PROMPT}`],
    ['an extra writable dir', `codex ${TRUST} --add-dir / ${PROMPT}`],
    ['a feature switch', `codex ${TRUST} --enable foo ${PROMPT}`],
    ['a sandbox config override', `codex ${TRUST} -c sandbox_mode=danger-full-access ${PROMPT}`],
    ['an approval config override', `codex ${TRUST} -c approval_policy=never ${PROMPT}`],
    ['another sandbox', `codex ${TRUST} -s danger-full-access ${PROMPT}`],
    ['another approval', `codex ${TRUST} -a on-request ${PROMPT}`],
    ['a duplicate -s', `codex ${TRUST} -s workspace-write -s workspace-write ${PROMPT}`],
    ['a duplicate -a', `codex ${TRUST} -a never -a never ${PROMPT}`],
    ['a subcommand', `codex resume --last`],
    ['exec', `codex exec ${TRUST} ${PROMPT}`],
    ['a profile', `codex ${TRUST} -p other ${PROMPT}`],
    ['no trust override', `codex -a never ${PROMPT}`],
    ['another folder\'s trust', `codex ${codexTrustOverride('/elsewhere', 'darwin')} ${PROMPT}`],
    ['a chained command', `codex ${TRUST} ${PROMPT}; rm -f x`],
    ['a command before', `cd /tmp && codex ${TRUST} ${PROMPT}`],
    ['a flag-shaped model', `codex ${TRUST} --model --yolo ${PROMPT}`],
    ['a substitution in a flag', `codex ${TRUST} --model "$(echo x)" ${PROMPT}`],
    ['no prompt argument', `codex ${TRUST}`],
    ['a launcher path', `/usr/local/bin/codex ${TRUST} ${PROMPT}`],
  ])('refuses %s', (_why, line) => {
    expect(parseCodexWorkerLine(line, CWD)).toBeNull();
  });

  it('refuses a worktree path it cannot write as one word', () => {
    expect(parseCodexWorkerLine(FANOUT_LINE.replace(CWD, "/a'b"), "/a'b")).toBeNull();
  });

  it('rebuilds the line with main\'s own sandbox, approval, writable roots and network', () => {
    const parsed = parseCodexWorkerLine(FANOUT_LINE, CWD)!;
    const line = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git/worktrees/x', '/repo/.git'])!;
    expect(line).toBe(
      `codex ${TRUST} -a never -s workspace-write -c 'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/x","/repo/.git"]' ` +
      `-c sandbox_workspace_write.network_access=true --model gpt-6.1-sol -c model_reasoning_effort=low -C '${CWD}' -- ${PROMPT}`,
    );
    expect(buildCodexWorkerLaunchLine(parsed, CWD, [])).toBeNull();
    expect(buildCodexWorkerLaunchLine(parsed, CWD, ['/a$b'])).toBeNull();
  });

  it('names codex anywhere on a line', () => {
    expect(namesCodex('codex resume --last')).toBe(true);
    expect(namesCodex('cd /w && codex')).toBe(true);
    expect(namesCodex('claude --resume x')).toBe(false);
    expect(namesCodex('codex; :')).toBe(true);
    expect(namesCodex('true&&codex')).toBe(true);
    expect(namesCodex('/opt/bin/codex resume')).toBe(true);
    expect(namesCodex('git log --grep codexy')).toBe(false);
  });

  it('reads the version and holds the measured floor', () => {
    expect(parseCodexVersion('codex-cli 0.162.1\n')).toEqual([0, 162, 1]);
    expect(parseCodexVersion('nope')).toBeNull();
    expect(codexVersionAtLeastFloor([0, 162, 1])).toBe(true);
    expect(codexVersionAtLeastFloor([0, 163, 0])).toBe(true);
    expect(codexVersionAtLeastFloor([0, 162, 0])).toBe(false);
    expect(codexVersionAtLeastFloor([0, 99, 9])).toBe(false);
  });
});

describe('the codex worker rules', () => {
  const rules = buildCodexWorkerRules({ repoKey: 'acme/app', cwd: CWD, gitDirs: ['/repo/.git'] });

  it('every rule forbids, and says why in words the model reads', () => {
    const lines = rules.split('\n').filter((l) => l.startsWith('prefix_rule('));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      expect(l).toContain('decision="forbidden"');
      expect(l).toContain(`justification="${CODEX_WORKER_JUSTIFICATION_PREFIX} `);
    }
    expect(rules).toContain('["git", "push"]');
    expect(rules).toContain('["gh", "api"]');
    expect(rules).toContain('"--repo=acme/app"');
    expect(rules).toContain('"--git-dir=/repo/.git"');
  });

  // Codex's own matcher, when a codex CLI is installed here (not in CI).
  const home = process.env.WMUX_TEST_REAL_HOME ?? os.homedir();
  const codex = [path.join(home, '.local', 'node', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find((p) => fs.existsSync(p));
  it.skipIf(!codex)('Codex refuses what the rules name and lets the rest through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-rules-'));
    try {
      const file = path.join(dir, 'w.rules');
      fs.writeFileSync(file, rules);
      const decide = (cmd: string[]): string => {
        const out = JSON.parse(execFileSync(codex!, ['execpolicy', 'check', '--rules', file, ...cmd], { encoding: 'utf8' })) as { decision?: string };
        return out.decision ?? 'none';
      };
      for (const cmd of [
        ['gh', 'pr', 'merge', '3'], ['gh', '-R', 'o/r', 'pr', 'merge', '3'], ['gh', 'pr', '-R', 'o/r', 'merge'], ['gh', '--repo=acme/app', 'pr', 'merge'],
        ['gh', 'api', 'repos/o/r/pulls/3/merge', '-X', 'PUT'], ['gh', 'issue', 'comment', '4'], ['git', 'push', 'origin', 'wtask/a'],
        ['git', '-C', '/w', 'push'], ['git', '-c', 'x=y', 'push'], ['git', 'config', 'remote.origin.pushurl', 'x'], ['git', 'remote', 'set-url', 'origin', 'x'],
        ['git', '--git-dir=/repo/.git', 'push'], ['git', '--no-pager', 'push'], ['git', '-p', 'push'],
      ]) expect(decide(cmd), cmd.join(' ')).toBe('forbidden');
      for (const cmd of [['gh', 'pr', 'view', '3'], ['gh', 'pr', 'create', '--fill'], ['git', 'commit', '-m', 'push it'], ['git', 'status'], ['git', 'remote', '-v']]) {
        expect(decide(cmd), cmd.join(' ')).toBe('none');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
