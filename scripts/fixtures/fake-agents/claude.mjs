#!/usr/bin/env node
// Fake Claude Code — live-dogfood fixture for #1680 (fresh context per task).
//
// LAUNCH IT BY PATH, e.g. in a wmux pane:
//   node D:\wmux-work\w1680\scripts\fixtures\fake-agents\claude.mjs
// wmux's daemon attributes a `node <script>` process to an agent only when the
// script token is a PATH whose basename (extension stripped) is the agent slug
// (src/daemon/AgentProcessTracker.ts resolveAgentSlug). `node claude.mjs`
// without a directory is read as the user's own file and is NOT attributed.
// The screen gate opens on the splash row and the OSC title below; process
// attribution (agentVerified) lags the tracker's poll by up to ~30 s.
//
// What it does:
//   - draws a Claude Code-like splash, a `❯` composer between rules, and the
//     bypass-permissions footer (idle reads as `waiting`);
//   - `/clear` (also `/reset`, `/new`): after FAKE_CLEAR_MS the conversation
//     and screen are cleared and SessionStart(source "clear") fires;
//   - any other line is a turn: UserPromptSubmit, FAKE_TURN_MS (or N s for
//     `work N`), then `● done: … (context: K earlier prompts …)` and Stop. K is
//     how a dogfood run sees whether the conversation was cleared;
//   - `/exit`, Ctrl+D on an empty composer, or Ctrl+C twice exits;
//   - `claude "<prompt>"` runs that prompt as the first turn, as Claude Code
//     does;
//   - `--version` and `auth status --json` answer without the TUI, so the
//     first-run "Agent ready" card reads it as installed and signed in
//     (fakeAgentCli.mjs; FAKE_CLAUDE_SIGNED_OUT=1 reports signed out);
//   - `--output-format stream-json` (a Claude Agent SDK spawn, such as a
//     bot's turn) answers each prompt with `Fake answer: …` over the SDK's
//     stdio protocol, with no TUI and no hooks (fakeAgentSdk.mjs).
//
// Hooks run ONLY when pointed at explicitly — never from the home directory or
// CLAUDE_CONFIG_DIR (wmux sets that for account panes, which would make it the
// operator's real config), so a stray run cannot fire real hooks:
//   FAKE_CLAUDE_HOOKS          a settings.json or plugin hooks.json; its
//                              `hooks.SessionStart / UserPromptSubmit / Stop`
//                              command entries (matcher "" only) are run
//   FAKE_CLAUDE_PLUGIN_ROOT    value for ${CLAUDE_PLUGIN_ROOT} (default: the
//                              folder above hooks/hooks.json)
//   FAKE_NO_HOOKS=1            run none
// Each command gets Claude Code's hook JSON on stdin and the pane's own
// environment (WMUX_PTY_ID etc.) plus CLAUDE_CODE_ENTRYPOINT=cli.
// See fakeAgentTui.mjs for FAKE_CLEAR_MS, FAKE_CLEAR_NEVER_SETTLES,
// FAKE_TURN_MS and FAKE_AGENT_LOG.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { envFlag, makeLogger, runFakeTui } from './fakeAgentTui.mjs';
import { answerProbe, parseFakeAgentArgs } from './fakeAgentCli.mjs';
import { runFakeSdk } from './fakeAgentSdk.mjs';

const log = makeLogger('claude');
const cli = parseFakeAgentArgs('claude', process.argv.slice(2));

function hooksFile() {
  return process.env.FAKE_CLAUDE_HOOKS || undefined;
}

function loadHooks() {
  if (envFlag('FAKE_NO_HOOKS')) return { file: undefined, hooks: {} };
  const file = hooksFile();
  if (!file) return { file: undefined, hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { file, hooks: parsed && typeof parsed.hooks === 'object' && parsed.hooks ? parsed.hooks : {} };
  } catch (err) {
    log('hooks_unreadable', { file, error: String(err) });
    return { file, hooks: {} };
  }
}

// A `--version` / `auth status` probe runs no hooks, so it reads none.
const { file: HOOKS_FILE, hooks: HOOKS } = cli.kind === 'tui' ? loadHooks() : { file: undefined, hooks: {} };
const PLUGIN_ROOT =
  process.env.FAKE_CLAUDE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT ??
  (HOOKS_FILE ? path.dirname(path.dirname(HOOKS_FILE)) : '');

/** Commands configured for an event, from groups without a tool matcher. */
function commandsFor(event) {
  const groups = Array.isArray(HOOKS[event]) ? HOOKS[event] : [];
  const out = [];
  for (const group of groups) {
    if (group && group.matcher && group.matcher !== '*') continue;
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (h && h.type === 'command' && typeof h.command === 'string') {
        out.push(h.command.split('${CLAUDE_PLUGIN_ROOT}').join(PLUGIN_ROOT));
      }
    }
  }
  return out;
}

function fireHook(event, conversation, extra = {}) {
  const payload = {
    session_id: conversation.id,
    cwd: process.cwd(),
    hook_event_name: event,
    permission_mode: 'default',
    ...extra,
  };
  for (const command of commandsFor(event)) {
    const started = Date.now();
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('error', (err) => log('hook_error', { hookEvent: event, error: String(err) }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      log('hook', { hookEvent: event, source: extra.source, code, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify(payload));
  }
}

if (cli.kind === 'sdk') runFakeSdk(cli, log);
else if (!answerProbe('claude', cli, log)) runFakeTui({
  agent: 'claude',
  initialPrompt: cli.prompt,
  title: '✳ Claude Code',
  header: () => [
    ' ▐▛███▜▌   Claude Code v9.9.9',
    '▝▜█████▛▘  Fake model · fixture',
    '  ▘▘ ▝▝    ' + process.cwd(),
  ],
  promptGlyph: '❯',
  footer: ['  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
  freshCommands: ['/clear', '/reset', '/new'],
  // Claude Code redraws a fresh screen without the splash after /clear.
  headerOnFresh: false,
  freshSource: 'clear',
  onSessionStart: (source, conversation) => fireHook('SessionStart', conversation, { source }),
  onPrompt: (text, conversation) => fireHook('UserPromptSubmit', conversation, { prompt: text }),
  onTurnEnd: (_text, conversation) => fireHook('Stop', conversation, { stop_hook_active: false }),
});
