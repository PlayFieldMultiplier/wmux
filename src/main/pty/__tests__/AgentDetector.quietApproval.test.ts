import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetector, type AgentSlug } from '../AgentDetector';
import { generateTextSnapshot } from '../../../daemon/HeadlessSnapshot';
import codex from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/codex-approval-exec-01.json';
import openCode from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/opencode-permission-bash-01.json';
import claude from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/claude-write-01-create.json';
import type { ApprovalScreenSnapshot } from '../../../shared/approvalScreen';
import { claudeScreenApproval, codexScreenApproval, folderTrustScreenApproval, piScreenApproval, qwenScreenApproval } from '../approvalScreen';
import piCapture from './fixtures/pi-1.4.0-capture.json';
import qwenWide from './fixtures/qwen-code-0.26.1-120x40.json';
import qwenNarrow from './fixtures/qwen-code-0.26.1-60x30.json';
import qwenDialogs from './fixtures/qwen-code-0.26.1-60x30-dialogs.json';
import claudeTrust from './fixtures/claude-code-2.1.310-trust-120x40.json';
import codexTrust from './fixtures/codex-0.162.1-trust-120x40.json';
import fs from 'node:fs';
import path from 'node:path';

const TRUST = ['Do you trust the contents of this project?', '❯ Yes, I trust this folder', '  No, exit', '↑/↓ Navigate · enter Confirm'];
const CODEX_EDIT = ['Would you like to make the following edits?', '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)', 'Press enter to confirm or esc to cancel'] as const;
function setup(slug: AgentSlug = 'agy', output = TRUST.join('\r\n')) {
  const det = new AgentDetector();
  const events = vi.fn();
  det.onEvent(events);
  det.feed(output);
  det.seedTrustedIdentity(slug, det.getIdentityEpoch());
  return { det, events };
}
function frame(rows: readonly string[] = TRUST): ApprovalScreenSnapshot {
  return { rows, isCurrent: () => true };
}
function deferred() {
  let resolve: (value: ApprovalScreenSnapshot | null) => void = () => undefined;
  const promise = new Promise<ApprovalScreenSnapshot | null>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe('quiet approval recovery reads only the current interactive viewport', () => {
  it('recovers a bannerless trust screen without any later output or invented turn', async () => {
    const { det, events } = setup();
    expect(events).not.toHaveBeenCalled();
    const read = vi.fn(async () => frame());
    expect(await det.revalidateApprovalScreen(read)).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { agent: 'Antigravity CLI', status: 'awaiting_input', message: 'Project trust prompt' },
    ]);
    expect(det.getLastAgent()).toBeNull();
    det.seedTrustedIdentity('agy', det.getIdentityEpoch());
    expect(await det.revalidateApprovalScreen(read)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    det.feed(`${TRUST[0]}\n`);
    expect(events).toHaveBeenCalledTimes(1); // normal stream dedup agrees with recovery
  });

  it.each([
    ['codex', codex.screen],
    ['opencode', openCode.screen],
    ['claude', claude.screen],
  ] as const)('recovers a real %s permission fixture using its current choice/footer structure', async (slug, rows) => {
    // The full Codex banner already opens normal stream detection. Quiet
    // recovery starts with only a question hint but reads the complete grid.
    const output = slug === 'codex' ? 'Would you like to run the following command?\r\n' : rows.join('\r\n');
    const { det, events } = setup(slug, output);
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });

  // The folder path wrapped so that a row of it starts like a choice.
  const narrow = piCapture.screens.trustNarrow;
  const pathRow = narrow.indexOf(' er-name/and-a-deeper-trustproj');
  if (pathRow < 0) throw new Error('pi-1.4.0-capture.json: the wrapped path row this test rewrites is gone');
  const trustRepoPath = narrow.map((row, i) => (i === pathRow ? ' Trust-repo/and-a-deeper-trustproj' : row));

  it.each([
    ['120 columns', piCapture.chunks.trust, piCapture.screens.trust],
    // The parent-folder path and the key footer wrap onto rows of their own.
    ['44 columns', piCapture.chunks.trustNarrow, piCapture.screens.trustNarrow],
    ['44 columns, a path row reading Trust-repo/…', piCapture.chunks.trustNarrow, trustRepoPath],
  ])('recovers Pi\'s captured project-trust selector at %s', async (_label, output, rows) => {
    // Drawn before Pi's title, so only a later process identity can claim it.
    const { det, events } = setup('pi', output);
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { agent: 'Pi', status: 'awaiting_input', message: 'Project trust prompt' },
    ]);
  });

  it.each(['identity, then the selector', 'the selector, then identity', 'identity between the question and its footer'] as const)(
    'reads Pi\'s selector once, whichever comes first: %s', async (order) => {
      const det = new AgentDetector();
      const events = vi.fn();
      det.onEvent(events);
      const read = vi.fn(async () => frame(piCapture.screens.trust));
      if (order === 'identity between the question and its footer') {
        const { trust } = piCapture.chunks;
        const split = trust.indexOf('Trust project folder?') + 'Trust project folder?'.length;
        det.feed(trust.slice(0, split));
        det.seedTrustedIdentity('pi', det.getIdentityEpoch());
        // The question is fresh but unfinished: the seed-time recheck waits.
        expect(await det.revalidateApprovalScreen(read)).toBe(false);
        expect(read).not.toHaveBeenCalled();
        det.feed(trust.slice(split));
        expect(det.takeApprovalRecheckRequest()).toBe(true);
      } else if (order === 'identity, then the selector') {
        det.seedTrustedIdentity('pi', det.getIdentityEpoch());
        // The host's seed-time recheck: nothing is fresh yet, and it is not spent.
        expect(await det.revalidateApprovalScreen(read)).toBe(false);
        det.feed(piCapture.chunks.trust);
        expect(det.takeApprovalRecheckRequest()).toBe(true);
        expect(det.takeApprovalRecheckRequest()).toBe(false);
      } else {
        det.feed(piCapture.chunks.trust);
        det.seedTrustedIdentity('pi', det.getIdentityEpoch());
        // No owner when the question was drawn: the seed-time recheck reads it.
        expect(det.takeApprovalRecheckRequest()).toBe(false);
      }
      expect(await det.revalidateApprovalScreen(read)).toBe(true);
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { agent: 'Pi', status: 'awaiting_input', message: 'Project trust prompt' },
      ]);
      // The one recheck is spent: a redraw of the selector asks for nothing.
      det.feed(piCapture.chunks.trust);
      expect(det.takeApprovalRecheckRequest()).toBe(false);
    },
  );

  // Each capture's whole output, rendered as the host's grid reader would.
  it.each([
    ['claude', claudeTrust.frames.trust, 'Claude Code', 'Project trust prompt', 'Enter'],
    ['codex', codexTrust.frames.trust, 'Codex CLI', 'Directory trust prompt', 'enter'],
  ] as const)('reads the captured %s folder-trust screen as awaiting_input, and ends on it', async (slug, output, agent, message, footer) => {
    const rendered = await generateTextSnapshot({ cols: 120, rows: 40, scrollback: 0, initial: Buffer.from(output) });
    if (!rendered.ok) throw new Error('the capture did not render');
    const rows = rendered.rows.map((row) => row.text);
    const orders = ['identity, then the screen', 'the screen, then identity', 'identity before the footer', 'identity after another question',
      'the screen while the previous agent still owned the pane'] as const;
    for (const order of orders) {
      const det = new AgentDetector();
      const events = vi.fn();
      det.onEvent(events);
      const read = vi.fn(async () => frame(rows));
      if (order === 'identity, then the screen') {
        // The command-start probe seeds the agent before it draws anything.
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
        expect(await det.revalidateApprovalScreen(read)).toBe(false);
        det.feed(output);
        expect(det.takeApprovalRecheckRequest()).toBe(true);
      } else if (order === 'the screen while the previous agent still owned the pane') {
        // Its late death edge lands after the screen is drawn.
        det.seedTrustedIdentity('agy', det.getIdentityEpoch());
        det.feed(output);
        det.clearTrustedIdentity();
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
      } else if (order === 'identity after another question') {
        // A question shortly before the launch: the seed-time recheck reads
        // (and spends) the general recheck, not the trust screen's.
        det.feed('Would you like me to run the tests?\r\n');
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
        expect(await det.revalidateApprovalScreen(async () => frame([]))).toBe(false);
        det.feed(output);
        expect(det.takeApprovalRecheckRequest()).toBe(true);
      } else if (order === 'identity before the footer') {
        const split = output.lastIndexOf(footer);
        det.feed(output.slice(0, split));
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
        // The seed-time recheck sees the screen unfinished; the footer asks again.
        const half = await generateTextSnapshot({ cols: 120, rows: 40, scrollback: 0, initial: Buffer.from(output.slice(0, split)) });
        expect(await det.revalidateApprovalScreen(async () => frame(half.ok ? half.rows.map((row) => row.text) : []))).toBe(false);
        det.feed(output.slice(split));
        expect(det.takeApprovalRecheckRequest()).toBe(true);
      } else {
        det.feed(output);
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
      }
      expect(await det.revalidateApprovalScreen(read)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      const statuses = events.mock.calls.map(([event]) => event);
      expect(statuses.at(-1)).toEqual({ agent, status: 'awaiting_input', message });
      // Codex's loading banner opens its gate ("Agent started") when no identity came first.
      expect(statuses.slice(0, -1)).toEqual((order === 'the screen, then identity' || order === 'identity before the footer') && slug === 'codex'
        ? [{ agent, status: 'running', message: 'Agent started' }] : []);
    }
    // A narrow pane wraps the question row; the reader keys on its start.
    const q = rows.findIndex((row) => /Quick safety check:|Trust this folder\?/.test(row));
    const wrapped = [...rows.slice(0, q), rows[q].slice(0, 32), ` ${rows[q].slice(32)}`, ...rows.slice(q + 1)];
    expect((slug === 'claude' ? claudeScreenApproval : codexScreenApproval)(wrapped)?.message).toBe(message);

    // The same unanswered screen after a resize narrows the pane is not a new dialog.
    const narrow = await generateTextSnapshot({ cols: 100, rows: 40, scrollback: 0, initial: Buffer.from(output) });
    if (!narrow.ok) throw new Error('the capture did not render');
    const narrowRows = narrow.rows.map((row) => row.text);
    expect(narrowRows.find((row) => /Quick safety check:|Trust this folder\?/.test(row))).not.toBe(rows[q]);
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity(slug, det.getIdentityEpoch());
    det.feed(output);
    expect(det.takeApprovalRecheckRequest() && await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    det.invalidateApprovalScreen();
    det.feed(output);
    expect(det.takeApprovalRecheckRequest()).toBe(true);
    const narrowRead = vi.fn(async () => frame(narrowRows));
    expect(await det.revalidateApprovalScreen(narrowRead)).toBe(false);
    expect(narrowRead).toHaveBeenCalledTimes(1);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });

  it('asks for Pi\'s recheck only once the selector\'s last row is drawn, however the reads split', () => {
    const { trust, trustNarrow } = piCapture.chunks;
    for (const output of [trust, trustNarrow]) {
      // Where the first draw's key footer ends on the wire (SGR runs sit inside it).
      const footerEnd = output.indexOf('cancel', output.indexOf('escape/ctrl+c')) + 'cancel'.length;
      for (const size of [1, 7, 64, 500]) {
        const det = new AgentDetector();
        det.seedTrustedIdentity('pi', det.getIdentityEpoch());
        let before = -1;
        let after = -1;
        for (let at = 0; at < output.length && after < 0; at += size) {
          det.feed(output.slice(at, at + size));
          if (det.takeApprovalRecheckRequest()) [before, after] = [at, at + size];
        }
        expect(before).toBeLessThan(footerEnd);
        expect(after).toBeGreaterThanOrEqual(footerEnd);
      }
    }
  });

  it.each([
    ['a profile whose questions reach its line patterns', 'agy', TRUST.join('\r\n')],
    // Generic question words in a Pi reply are not its selector.
    ['a Pi reply asking a question', 'pi', 'Would you like me to run the tests?\r\n'],
    // The captured key footer under a reply's question words: another Pi picker.
    ['Pi\'s key footer under no trust question', 'pi', 'Would you like me to run the tests?\r\n ↑↓ navigate  enter select  escape/ctrl+c cancel\r\n'],
    // The question is not finished by a footer drawn above it.
    ['a footer drawn before the trust question in one read', 'pi', ' ↑↓ navigate  enter select  escape/ctrl+c cancel\r\n Trust project folder?\r\n'],
  ] as const)('asks for no recheck on %s', (_label, slug, output) => {
    const det = new AgentDetector();
    det.seedTrustedIdentity(slug, det.getIdentityEpoch());
    det.feed(output);
    expect(det.takeApprovalRecheckRequest()).toBe(false);
  });

  it.each(['the bridge ends it first', 'the seed replaces it', 'the bridge ends it before the footer'] as const)(
    'reads Pi\'s selector drawn while a previous agent still owned the pane (%s)', async (how) => {
      const det = new AgentDetector();
      const events = vi.fn();
      det.onEvent(events);
      det.seedTrustedIdentity('claude', det.getIdentityEpoch());
      const { trust } = piCapture.chunks;
      const footer = trust.indexOf('escape/ctrl+c');
      if (how === 'the bridge ends it before the footer') {
        // The previous agent's late death edge lands mid-selector; the footer
        // drawn before Pi's seed still counts.
        det.feed(trust.slice(0, footer));
        det.clearTrustedIdentity();
        det.feed(trust.slice(footer));
      } else {
        det.feed(trust);
        if (how === 'the bridge ends it first') det.clearTrustedIdentity();
      }
      det.seedTrustedIdentity('pi', det.getIdentityEpoch());
      expect(await det.revalidateApprovalScreen(async () => frame(piCapture.screens.trust))).toBe(true);
      expect(events.mock.calls.map(([event]) => event)).toEqual([
        { agent: 'Pi', status: 'awaiting_input', message: 'Project trust prompt' },
      ]);
    },
  );

  it.each([
    ['Pi, from another agent\'s question', 'pi', TRUST.join('\r\n'), false],
    // Claude keeps a retired hint only for its own trust question.
    ['Claude, from another agent\'s question', 'claude', TRUST.join('\r\n'), false],
    ['Pi, from its selector answered before the seed', 'pi', piCapture.chunks.trust, true],
    // A profile with line patterns keeps the old rule: an identity change drops the hint.
    ['agy, from its own question drawn under the previous owner', 'agy', TRUST.join('\r\n'), false],
  ] as const)('keeps no retired hint for %s', async (_label, slug, output, answered) => {
    const det = new AgentDetector();
    det.seedTrustedIdentity('claude', det.getIdentityEpoch());
    det.feed(output);
    det.clearTrustedIdentity();
    if (answered) det.invalidateApprovalScreen();
    det.seedTrustedIdentity(slug, det.getIdentityEpoch());
    const read = vi.fn(async () => frame(slug === 'pi' ? piCapture.screens.trust : TRUST));
    expect(await det.revalidateApprovalScreen(read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 1024])('reads Pi\'s selector on a 400-column pane (reads of %i bytes; 0 = one read)', async (size) => {
    // The captured selector with each row's padding widened from 120 to 400
    // columns: its question and its footer end up more than 4 KB apart.
    const wide = piCapture.chunks.trust.replace(/ {20,}/g, (pad) => pad + ' '.repeat(280));
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity('pi', det.getIdentityEpoch());
    for (let at = 0; at < wide.length; at += size || wide.length) det.feed(wide.slice(at, at + (size || wide.length)));
    expect(det.takeApprovalRecheckRequest()).toBe(true);
    expect(await det.revalidateApprovalScreen(async () => frame(piCapture.screens.trust))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });

  it('asks once per drawn footer, not again on later output', () => {
    const det = new AgentDetector();
    det.seedTrustedIdentity('pi', det.getIdentityEpoch());
    const { trust } = piCapture.chunks;
    // The first draw only: its footer, then the redraw's opening bytes.
    const firstFooterEnd = trust.indexOf('cancel', trust.indexOf('escape/ctrl+c')) + 'cancel'.length;
    det.feed(trust.slice(0, firstFooterEnd));
    expect(det.takeApprovalRecheckRequest()).toBe(true);
    det.feed('\u001b[?25l');
    expect(det.takeApprovalRecheckRequest()).toBe(false);
  });

  it.each(['a seed', 'its title'] as const)(
    'gives a new Pi launch nothing of the last one\'s unfinished selector (identified by %s)', (by) => {
      const det = new AgentDetector();
      if (by === 'a seed') det.seedTrustedIdentity('pi', det.getIdentityEpoch());
      else det.feed(piCapture.chunks.startup);
      det.feed(' Trust project folder?\r\n');
      det.clearTrustedIdentity();
      det.seedTrustedIdentity('pi', det.getIdentityEpoch());
      // Any Pi picker draws this footer; it finishes no question of this launch.
      det.feed(' ↑↓ navigate  enter select  escape/ctrl+c cancel\r\n');
      expect(det.takeApprovalRecheckRequest()).toBe(false);
    },
  );

  it('drops a pending Pi recheck once input or a resize makes the screen stale', () => {
    const det = new AgentDetector();
    det.seedTrustedIdentity('pi', det.getIdentityEpoch());
    det.feed(piCapture.chunks.trust);
    det.invalidateApprovalScreen();
    expect(det.takeApprovalRecheckRequest()).toBe(false);
  });

  it('reads no approval from Pi\'s other captured screens', () => {
    const { idle, working, done, tool, trust } = piCapture.screens;
    // The selector with no selected choice, or with no way to decline, is not it.
    const unselected = trust.filter((row) => !row.startsWith(' →'));
    const noDecline = trust.filter((row) => !row.includes('Do not trust'));
    for (const rows of [idle, working, done, tool, unselected, noDecline]) {
      expect(piScreenApproval(rows)).toBeNull();
    }
  });

  describe('a question drawn after an identity change is kept for the next owner', () => {
    const dialogs = [
      ['claude', claude.screen.join('\r\n'), claude.screen],
      ['codex', 'Would you like to run the following command?\r\n', codex.screen],
      ['agy', TRUST.join('\r\n'), TRUST],
      ['opencode', openCode.screen.join('\r\n'), openCode.screen],
    ] as const;

    it.each(dialogs)('a launch (OSC 133 C), then a %s dialog, then its seed', async (slug, output, rows) => {
      const det = new AgentDetector({ launchBoundaries: true });
      const events = vi.fn();
      det.onEvent(events);
      det.feed('\u001b]133;C\u0007');
      det.feed(output);
      det.seedTrustedIdentity(slug, det.getIdentityEpoch());
      expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
      expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
    });

    it.each([
      ['agy after a cleared identity', 'codex', 'agy', TRUST.join('\r\n'), TRUST],
      ['claude after codex died', 'codex', 'claude', claude.screen.join('\r\n'), claude.screen],
    ] as const)('%s', async (_label, previous, slug, output, rows) => {
      const det = new AgentDetector();
      const events = vi.fn();
      det.onEvent(events);
      det.seedTrustedIdentity(previous, det.getIdentityEpoch());
      det.clearTrustedIdentity();
      det.feed(output);
      det.seedTrustedIdentity(slug, det.getIdentityEpoch());
      expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
      expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
    });
  });

  it('recovers a live edit dialog whose body exceeds 24 nonblank viewport rows', async () => {
    const rows = [CODEX_EDIT[0], ...Array.from({ length: 32 }, (_, i) => `+ added line ${i}`), ...CODEX_EDIT.slice(1)];
    const { det, events } = setup('codex', rows.join('\r\n'));
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });

  it('uses the newest live question when an answered dialog remains above it', async () => {
    const rows = ['Would you like to run the following command?', ...CODEX_EDIT.slice(1),
      'Command finished', ...CODEX_EDIT];
    expect(codexScreenApproval(rows)?.text).toBe(CODEX_EDIT[0]);
    const { det, events } = setup('codex', rows.join('\r\n'));
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
  });

  it.each([
    ['output after the footer', [...CODEX_EDIT, 'Applied the edits']],
    ['output before a redrawn footer', [...CODEX_EDIT.slice(0, -1), 'Applied the edits', CODEX_EDIT[3]]],
    ['a newer question without choices', [...CODEX_EDIT, 'Applied the edits', CODEX_EDIT[0], CODEX_EDIT[3]]],
  ])('rejects stale Codex choices with %s', async (_label, rows) => {
    const { det, events } = setup('codex', rows.join('\r\n'));
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });

  it.each([
    ['bare question', [TRUST[0]]],
    ['unselected choices', [TRUST[0], 'Yes, I trust this folder', 'No, exit', TRUST[3]]],
    ['old dialog above new output', [...TRUST, 'The task is running now']],
    ['ordinary task status', ['Applied edit to a.py', 'esc to cancel', 'aider v0.86.1']],
    ['cleared viewport', []],
  ])('does not infer approval from %s', async (_label, rows) => {
    const { det, events } = setup();
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });

  it('waits for the real headless parser and excludes a cleared old dialog and scrollback', async () => {
    const old = TRUST.join('\r\n');
    for (const clear of ['\x1b[2J\x1b[Hready', '\r\n'.repeat(30) + 'ready']) {
      const { det, events } = setup('agy', old + clear);
      const result = await det.revalidateApprovalScreen(async () => {
        const rendered = await generateTextSnapshot({ cols: 100, rows: 12, scrollback: 0, initial: Buffer.from(old + clear) });
        expect(rendered.ok).toBe(true);
        return rendered.ok ? frame(rendered.rows.map((row) => row.text)) : null;
      });
      expect(result).toBe(false);
      expect(events).not.toHaveBeenCalled();
    }
  });

  it.each(['input', 'shell', 'death', 'replacement'] as const)('rejects an in-flight grid after %s', async (change) => {
    const { det, events } = setup();
    const screen = deferred();
    const result = det.revalidateApprovalScreen(() => screen.promise);
    if (change === 'input') det.invalidateApprovalScreen();
    if (change === 'shell') det.feed('\x1b]133;A\x07');
    if (change === 'death') det.clearTrustedIdentity();
    if (change === 'replacement') det.seedTrustedIdentity('codex', det.getIdentityEpoch());
    screen.resolve(frame());
    expect(await result).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });

  it('input before identity requires a new question, not a title-only redraw', async () => {
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.feed(TRUST.join('\n'));
    det.invalidateApprovalScreen();
    det.feed('\x1b]0;unrelated title\x07');
    det.seedTrustedIdentity('agy', det.getIdentityEpoch());
    const read = vi.fn(async () => frame());
    expect(await det.revalidateApprovalScreen(read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('re-reads once when output overtakes a render, without trusting its obsolete frame', async () => {
    const { det, events } = setup();
    const stale = deferred();
    const read = vi.fn().mockImplementationOnce(() => stale.promise).mockResolvedValueOnce(frame(['ready']));
    const result = det.revalidateApprovalScreen(read);
    det.feed('\x1b[2J\x1b[Hready');
    stale.resolve(frame());
    expect(await result).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(events).not.toHaveBeenCalled();
  });

  it('a newer real question refreshes an old prose hint, while title-only output does not', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.feed('Documentation: Do you trust this tool?\n');
    now.mockReturnValue(131_000);
    det.feed(TRUST.join('\r\n'));
    det.seedTrustedIdentity('agy', det.getIdentityEpoch());
    expect(await det.revalidateApprovalScreen(async () => frame())).toBe(true);
    expect(events).toHaveBeenCalledTimes(1);

    now.mockReturnValue(200_000);
    const old = setup();
    now.mockReturnValue(231_000);
    old.det.feed('\x1b]0;new title\x07');
    const read = vi.fn(async () => frame());
    expect(await old.det.revalidateApprovalScreen(read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('requires both a fresh candidate and the snapshot provider’s lifetime/geometry fence', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const { det, events } = setup();
    now.mockReturnValue(130_001);
    const read = vi.fn(async () => frame());
    expect(await det.revalidateApprovalScreen(read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const fresh = setup();
    expect(await fresh.det.revalidateApprovalScreen(async () => ({ rows: TRUST, isCurrent: () => false }))).toBe(false);
    expect(events).not.toHaveBeenCalled();
    expect(fresh.events).not.toHaveBeenCalled();
  });

  it.each([null, new Error('renderer unavailable')])('fails closed on unavailable screens (%s)', async (outcome) => {
    const { det, events } = setup();
    expect(await det.revalidateApprovalScreen(async () => { if (outcome) throw outcome; return null; })).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });
});

describe('Qwen Code 0.26.1 permission dialogs (live capture)', () => {
  const ASKED = { agent: 'Qwen Code', status: 'awaiting_input', message: 'Approval requested' };

  it.each([
    ['the 120x40 shell dialog', qwenWide.frames.approval, qwenWide.screens.approval],
    ['the 60x30 file-write dialog', qwenNarrow.frames.writeApproval, qwenNarrow.screens.writeApproval],
    ['the 60x30 shell dialog under a scrollbar thumb', qwenNarrow.frames.shellApprovalMidSession, qwenNarrow.screens.shellApprovalScrollbar],
    ['the 60x30 shell dialog whose question is cut with an ellipsis', qwenDialogs.frames.shellCut, qwenDialogs.screens.shellCut],
    ['the 60x30 edit dialog', qwenDialogs.frames.edit, qwenDialogs.screens.edit],
  ])('recovers %s drawn before Qwen\'s identity arrived', async (_label, output, rows) => {
    // Drawn while another agent's identity still held the pane, so no Qwen
    // line pattern read it; Qwen's seed then reads the grid once.
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity('claude', det.getIdentityEpoch());
    det.feed(output);
    det.clearTrustedIdentity();
    det.seedTrustedIdentity('qwen', det.getIdentityEpoch());
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([ASKED]);
  });

  it.each([
    ['as captured', qwenNarrow.frames.shellApprovalMidSession],
    // The same frames with the confirmation row's spaces drawn as cursor moves.
    ['drawn with cursor moves', qwenNarrow.frames.shellApprovalMidSession.replace(/Waiting for user/g, 'Waiting\u001b[1Cfor\u001b[1Cuser')],
  ])('leaves a dialog the stream reported to the stream, and its recheck agrees (%s)', async (_label, output) => {
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity('qwen', det.getIdentityEpoch());
    det.feed(output);
    expect(events.mock.calls.map(([event]) => event)).toEqual([ASKED]);
    // Reported in the same read: no grid read is asked for.
    expect(det.takeApprovalRecheckRequest()).toBe(false);
    // A recheck that runs anyway (the seed's own) finds the same dialog.
    expect(await det.revalidateApprovalScreen(async () => frame(qwenNarrow.screens.shellApprovalScrollbar))).toBe(false);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('reads no dialog once it is answered or cancelled, and asks for no recheck', () => {
    // After Enter the spinner keeps the confirmation phrase, beside its counters.
    expect(qwenScreenApproval(qwenWide.screens.answered)).toBeNull();
    expect(qwenScreenApproval(qwenNarrow.screens.afterEsc)).toBeNull();
    const det = new AgentDetector();
    det.seedTrustedIdentity('qwen', det.getIdentityEpoch());
    det.feed(qwenWide.frames.approval);
    det.takeApprovalRecheckRequest();
    det.feed(qwenWide.frames.afterApproval);
    expect(det.takeApprovalRecheckRequest()).toBe(false);
  });
});

describe('Gemini CLI and Qwen Code folder-trust dialogs (live captures)', () => {
  const FOLDER_TRUST = path.join(__dirname, '../../../daemon/approvals/__tests__/fixtures/folder-trust');
  const fixture = (name: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(FOLDER_TRUST, `${name}.json`), 'utf8')) as { screen: string[] }).screen;
  /** The rows as the agents write them: CRLF rows, the last choice's number and label in SGR runs of their own. */
  const drawn = (rows: readonly string[]): string =>
    rows.join('\r\n').replace(/3\. Don/g, '3.\u001b[39m \u001b[38;2;255;255;255mDon');
  const ASKED = (agent: string) => ({ agent, status: 'awaiting_input', message: 'Folder trust prompt' });

  it.each([
    ['gemini', 'Gemini CLI', 'gemini-folder-trust-120x40'],
    ['gemini', 'Gemini CLI', 'gemini-folder-trust-full-120x40'],
    ['gemini', 'Gemini CLI', 'gemini-folder-trust-22x30'],
    ['gemini', 'Gemini CLI', 'gemini-folder-trust-ctrlc-22x60'],
    // Every choice cut too short to read: still the dialog.
    ['gemini', 'Gemini CLI', 'gemini-folder-trust-18x60'],
    ['qwen', 'Qwen Code', 'qwen-folder-trust-120x40'],
    ['qwen', 'Qwen Code', 'qwen-folder-trust-28x50'],
    ['qwen', 'Qwen Code', 'qwen-folder-trust-22x30'],
    ['qwen', 'Qwen Code', 'qwen-folder-trust-18x60'],
  ] as const)('%s: reads the %s dialog %s once its last choice is drawn', async (slug, agent, name) => {
    const rows = fixture(name);
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity(slug, det.getIdentityEpoch());
    det.feed(drawn(rows));
    expect(det.takeApprovalRecheckRequest()).toBe(true);
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event)).toEqual([ASKED(agent)]);
  });

  it('asks for the recheck once the last choice is drawn, however the reads split (inside an escape too)', () => {
    for (const [slug, name] of [['gemini', 'gemini-folder-trust-60x30'], ['qwen', 'qwen-folder-trust-60x30']] as const) {
      const output = drawn(fixture(name));
      const endAt = output.indexOf('Don') + 'Don'.length;
      for (const size of [1, 7, 64, 500]) {
        const det = new AgentDetector();
        det.seedTrustedIdentity(slug, det.getIdentityEpoch());
        let after = -1;
        for (let at = 0; at < output.length && after < 0; at += size) {
          det.feed(output.slice(at, at + size));
          if (det.takeApprovalRecheckRequest()) after = at + size;
        }
        expect(after).toBeGreaterThanOrEqual(endAt);
      }
    }
  });

  it("leaves Qwen's permission dialogs to its own reader", () => {
    expect(folderTrustScreenApproval(qwenWide.screens.approval)).toBeNull();
    expect(qwenScreenApproval(qwenWide.screens.approval)).not.toBeNull();
  });

  it.each([
    // Gemini CLI 0.65.0's /auth menu (live capture): the same dot cursor, no trust question.
    ['the /auth menu', [
      '│ ? Get started                                                  │',
      '│   How would you like to authenticate for this project?         │',
      '│     1. Sign in with Google                                     │',
      '│   ● 2. Use Gemini API Key                                      │',
      '│     3. Vertex AI                                               │',
      '│   (Use Enter to select)                                        │',
      '╰────────────────────────────────────────────────────────────────╯',
    ]],
    ['a reply quoting the question over dot bullets', [
      '✦ When Gemini asks "Do you trust the files in this folder?" pick one of:',
      '● 1. Trust folder (proj)',
      '  2. Trust parent folder (work)',
      "  3. Don't trust",
    ]],
    ['the dialog already answered', fixture('gemini-folder-trust-answered-120x40')],
  ])('reads no folder-trust dialog in %s', async (_label, rows) => {
    expect(folderTrustScreenApproval(rows)).toBeNull();
    const det = new AgentDetector();
    const events = vi.fn();
    det.onEvent(events);
    det.seedTrustedIdentity('gemini', det.getIdentityEpoch());
    det.feed(drawn(rows));
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(false);
    expect(events).not.toHaveBeenCalled();
  });

  it('reads nothing before an identity, or for a question drawn over 30 s ago', async () => {
    const rows = fixture('gemini-folder-trust-120x40');
    const unowned = new AgentDetector();
    unowned.feed(drawn(rows));
    expect(await unowned.revalidateApprovalScreen(async () => frame(rows))).toBe(false);
    vi.useFakeTimers();
    try {
      const det = new AgentDetector();
      det.seedTrustedIdentity('gemini', det.getIdentityEpoch());
      det.feed(drawn(rows));
      vi.advanceTimersByTime(31_000);
      expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
