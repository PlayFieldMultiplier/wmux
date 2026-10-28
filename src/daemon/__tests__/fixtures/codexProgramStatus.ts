/**
 * Every OSC 7501 report Codex CLI 0.163 wrote in one recorded session, byte
 * for byte and in order, with the milliseconds since spawn and what the
 * session was doing. Codex reports without being asked (no `OSC 7501;?`).
 * Only the reports are kept: the rest of the capture is screen output.
 *
 * The session: boot, a one-word turn, then a turn that asks to run a shell
 * command, which is declined with Esc, then `/quit`.
 */
export const CODEX_0163_SESSION = [
  { at: 2479, step: 'boot', bytes: '\x1b]7501;state=idle:app=codex\x1b\\' },
  { at: 2928, step: 'boot', bytes: '\x1b]7501;state=working:app=codex\x1b\\' },
  { at: 6170, step: 'boot', bytes: '\x1b]7501;state=idle:app=codex\x1b\\' },
  // 9682: the first prompt is submitted.
  { at: 10433, step: 'turn 1', bytes: '\x1b]7501;state=working:app=codex\x1b\\' },
  { at: 14511, step: 'turn 1 ends', bytes: '\x1b]7501;state=idle:app=codex\x1b\\' },
  // 16469: the second prompt is submitted.
  { at: 16492, step: 'turn 2', bytes: '\x1b]7501;state=working:app=codex\x1b\\' },
  { at: 19208, step: 'approval box', bytes: '\x1b]7501;state=blocked:app=codex\x1b\\' },
  // 20789: declined with Esc.
  { at: 20790, step: 'declined', bytes: '\x1b]7501;state=working:app=codex\x1b\\' },
  { at: 20808, step: 'turn 2 ends', bytes: '\x1b]7501;state=idle:app=codex\x1b\\' },
  // 22896: `/quit` is submitted.
  { at: 28811, step: 'quit', bytes: '\x1b]7501;state=clear\x1b\\' },
] as const;
