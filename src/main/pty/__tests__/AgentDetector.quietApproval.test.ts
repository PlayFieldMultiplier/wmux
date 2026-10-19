import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetector, type AgentSlug } from '../AgentDetector';
import { generateTextSnapshot } from '../../../daemon/HeadlessSnapshot';
import codex from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/codex-approval-exec-01.json';
import openCode from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/opencode-permission-bash-01.json';
import claude from '../../../daemon/approvals/__tests__/fixtures/terminal-prompts/claude-write-01-create.json';
import type { ApprovalScreenSnapshot } from '../../../shared/approvalScreen';

const TRUST = ['Do you trust the contents of this project?', '❯ Yes, I trust this folder', '  No, exit', '↑/↓ Navigate · enter Confirm'];
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
    ['codex', codex.screen.slice(6)],
    ['opencode', openCode.screen],
    ['claude', claude.screen],
  ] as const)('recovers a real %s permission fixture using its current choice/footer structure', async (slug, rows) => {
    const { det, events } = setup(slug, rows.join('\r\n'));
    expect(await det.revalidateApprovalScreen(async () => frame(rows))).toBe(true);
    expect(events.mock.calls.map(([event]) => event.status)).toEqual(['awaiting_input']);
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
