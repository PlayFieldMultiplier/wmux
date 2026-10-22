// Non-interactive side of the fake agent CLIs (claude.mjs, codex.mjs): the
// `--version` and sign-in status probes the first-run "Agent ready" cards run
// (src/main/firstRun/AgentSetupDetector.ts and the `setup.loginStatus` rows in
// src/shared/agentIdentity.ts), and the prompt a launch line such as
// `claude "<prompt>"` hands the interactive TUI.
//
// Pure (argv and env in, an answer out) so scripts/__tests__/fakeAgentCli.test.mjs
// can pin it without spawning anything.
//
// Environment knobs:
//   FAKE_CLAUDE_SIGNED_OUT=1  `claude auth status --json` reports signed out
//                             (exit 1, "loggedIn": false), as Claude Code does
//   FAKE_CODEX_SIGNED_OUT=1   `codex login status` prints "Not logged in", exit 1

/** The version both fakes report: above every `setup.updateFloor`. */
export const FAKE_AGENT_VERSION = '9.9.9';

/**
 * Flags that take a value, so the value is not mistaken for the prompt. Only
 * the ones a wmux launch line or a user is likely to put before the prompt.
 */
const VALUE_FLAGS = new Set([
  '--session-id',
  '--resume',
  '--model',
  '--permission-mode',
  '--settings',
  '--mcp-config',
  '--append-system-prompt',
  '--add-dir',
  '--config',
  '--profile',
  '-c',
  '-m',
]);

/**
 * What one invocation asks for:
 *   { kind: 'version' }                  `--version` / `-v` / `-V`
 *   { kind: 'login-status' }             claude `auth status`, codex `login status`
 *   { kind: 'tui', prompt?: string }     anything else: the interactive TUI,
 *                                        with the first positional argument as
 *                                        its first prompt (as both CLIs do)
 */
export function parseFakeAgentArgs(agent, argv) {
  const args = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string');
  const first = args[0];
  if (first === '--version' || first === '-v' || first === '-V') return { kind: 'version' };
  if (agent === 'claude' && first === 'auth' && args[1] === 'status') return { kind: 'login-status' };
  if (agent === 'codex' && first === 'login' && args[1] === 'status') return { kind: 'login-status' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (a.trim()) return { kind: 'tui', prompt: a };
  }
  return { kind: 'tui' };
}

/**
 * The stdout and exit code of a probe, in the shape the detector reads:
 *   - claude `--version`: `9.9.9 (Claude Code)`;
 *     `auth status --json`: JSON with `loggedIn`, exit 0 signed in / 1 not.
 *   - codex `--version`: `codex-cli 9.9.9`;
 *     `login status`: exit 0 signed in, exit 1 + "Not logged in" when not.
 */
export function probeAnswer(agent, kind, env = {}) {
  if (kind === 'version') {
    return {
      code: 0,
      stdout: agent === 'claude' ? `${FAKE_AGENT_VERSION} (Claude Code)\n` : `codex-cli ${FAKE_AGENT_VERSION}\n`,
    };
  }
  if (agent === 'claude') {
    const signedOut = env.FAKE_CLAUDE_SIGNED_OUT === '1';
    const body = signedOut ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'fake' };
    return { code: signedOut ? 1 : 0, stdout: `${JSON.stringify(body, null, 2)}\n` };
  }
  return env.FAKE_CODEX_SIGNED_OUT === '1'
    ? { code: 1, stdout: 'Not logged in\n' }
    : { code: 0, stdout: 'Logged in using a fake account\n' };
}

/**
 * Answer a probe and return true, or return false for an interactive run.
 * The process is left to exit on its own (exitCode, no process.exit), so a
 * piped stdout is flushed first.
 */
export function answerProbe(agent, parsed, log) {
  if (parsed.kind === 'tui') return false;
  const answer = probeAnswer(agent, parsed.kind, process.env);
  log('probe', { kind: parsed.kind, code: answer.code });
  process.stdout.write(answer.stdout);
  process.exitCode = answer.code;
  return true;
}
