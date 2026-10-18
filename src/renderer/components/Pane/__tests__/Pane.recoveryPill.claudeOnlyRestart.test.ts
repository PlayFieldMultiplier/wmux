/**
 * The public report this guards (r/ClaudeAI): a Claude-only user saw the
 * post-restart pill read "resume claude | codex | gemini, seemingly chosen by
 * an RNG", and resume never restored anything.
 *
 * End to end, in the order it happens: Claude runs and its output names Codex
 * and Gemini; Claude exits and the shell prints more of the same; the daemon
 * restarts and offers the pill from what it persisted; the renderer turns that
 * offer and the saved binding into the line the click types. The pill must
 * name Claude and resume the exact conversation, whatever name the daemon
 * persisted for the pane: the one a hook or process proved, or a screen guess
 * left over from before that write was guarded.
 */
import { describe, it, expect } from 'vitest';
import { AgentDetector } from '../../../../main/pty/AgentDetector';
import { agentDisplayToSlug, type AgentSlug } from '../../../../shared/agentIdentity';
import { resumeOfferForRecovered, type ResumeBinding } from '../../../../shared/agentResume';
import { planRecoveryPillType } from '../Pane';

const SID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CWD = '/Users/me/repo';
const CLAUDE_SPLASH = '\u001b]0;✳ Claude Code\u0007 ▐▛███▜▌   Claude Code v2.1.274\r\n';
const CODEX_BANNER = '\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const SHELL_PROMPT_BACK = '\u001b]133;D;0\u0007\u001b]133;A\u0007% ';

/** Every agent the screen named, in order, while the pane ran Claude only. */
function runClaudeOnlyPane(): AgentSlug[] {
  const det = new AgentDetector();
  const named: AgentSlug[] = [];
  det.onEvent((e) => {
    const slug = agentDisplayToSlug(e.agent);
    if (slug && named[named.length - 1] !== slug) named.push(slug);
  });
  det.feed(CLAUDE_SPLASH);
  // Claude's replies compare the other agents, in prose and in tables.
  det.feed('⏺ I compared Codex and Gemini on this repo; Gemini CLI was slower.\r\n');
  det.feed('│ Model          │ Score │\r\n');
  det.feed('│ gemini-2.5-pro │ 63%   │\r\n');
  det.feed('│ Codex CLI │ OpenAI │\r\n');
  det.feed('\r\u001b[5C\u001b[1B>_ OpenAI Codex (v0.149.1) and\r');
  expect(det.getLastAgent()).toBe('Claude Code');
  // Claude exits. The shell echoes a folder named gemini and prints a file
  // that holds the comparison table and the quoted Codex banner row.
  det.feed(SHELL_PROMPT_BACK + 'ls gemini \r\n');
  det.feed(SHELL_PROMPT_BACK + 'cat compare.md\r\n');
  det.feed('│ gemini-2.5-pro │ 63% │\r\n');
  det.feed(CODEX_BANNER);
  return named;
}

function pillLineAfterRestart(persisted: {
  lastDetectedAgent?: string;
  lastDetectedAgentEvidence?: { source: string; at: number };
  resumeBinding: ResumeBinding;
}): { offer: string | undefined; line: string | undefined } {
  // Daemon restart: the recovered pane's offer, from the persisted record.
  const offer = resumeOfferForRecovered(persisted);
  if (!offer) return { offer, line: undefined };
  // Renderer: the exact session only when the binding is this launcher's.
  const binding = persisted.resumeBinding;
  const sessionId = binding.agent === offer && binding.cwd === CWD ? binding.sessionId : undefined;
  const plan = planRecoveryPillType({
    launcher: offer,
    sessionId,
    permFlag: '',
    forceSkip: true,
    resumeStage: 0,
    roleBinding: undefined,
  });
  return { offer, line: plan?.text };
}

describe('Claude-only pane: Codex and Gemini in the output, exit, daemon restart', () => {
  const resumeBinding: ResumeBinding = { agent: 'claude', sessionId: SID, cwd: CWD, ts: 5_000 };

  it('the screen never names Gemini, and names Codex only after Claude exited', () => {
    expect(runClaudeOnlyPane()).toEqual(['claude', 'codex']);
  });

  it('the pill names Claude and resumes the exact conversation', () => {
    const screenGuess = runClaudeOnlyPane().pop();
    const persistedNames = [
      // What the guarded daemon keeps: the name Claude's process proved.
      { lastDetectedAgent: 'claude', lastDetectedAgentEvidence: { source: 'process', at: 1_000 } },
      // What an unguarded daemon wrote: the screen's last guess.
      { lastDetectedAgent: screenGuess },
      { lastDetectedAgent: screenGuess, lastDetectedAgentEvidence: { source: 'screen', at: 9_000 } },
      // A Gemini name persisted by an older build.
      { lastDetectedAgent: 'gemini' },
      // No name at all, only the hook's binding.
      {},
    ];
    for (const name of persistedNames) {
      const { offer, line } = pillLineAfterRestart({ ...name, resumeBinding });
      expect(offer, JSON.stringify(name)).toBe('claude');
      expect(line, JSON.stringify(name)).toBe(`claude --resume ${SID}`);
    }
  });
});
