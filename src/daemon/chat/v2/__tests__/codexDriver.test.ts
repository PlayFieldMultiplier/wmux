import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { CodexDriver } from '../codex/codexDriver';
import { codexVersionFromUserAgent, codexVersionSupported, permissionsCard } from '../codex/codexProtocol';
import type { ChatV2DriverDecision, ChatV2DriverSink, ChatV2DriverStart } from '../types';
import { FakeCodex, THREAD_ID } from './fakeCodex';
import { tick, until } from './fakeClaude';

const HOST_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function setup(spec: Partial<ChatV2DriverStart> = {}) {
  const fake = new FakeCodex();
  const driver = new CodexDriver({ command: 'codex', backend: fake.backend() });
  const events: HarnessEvent[] = [];
  const decisions: ChatV2DriverDecision[] = [];
  const gone: string[] = [];
  const sink: ChatV2DriverSink = {
    event: (e) => events.push(e),
    decision: (d) => decisions.push(d),
    decisionGone: (id) => gone.push(id),
    exited: () => undefined,
  };
  const start = () => driver.start({
    cwd: '/tmp/x',
    env: { PATH: '/usr/bin', WMUX_GATE: '0' },
    mode: 'default',
    model: '',
    providerSession: { id: HOST_ID, mode: 'new' },
    ...spec,
  }, sink);
  const running = async () => {
    await start();
    await driver.send({ text: 'go', attachments: [] });
  };
  return { fake, driver, events, decisions, gone, start, running };
}

const DIFF = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';

describe('CodexDriver', () => {
  it('starts app-server with the session marker in argv and an explicit on-request thread', async () => {
    const t = setup();
    await t.start();
    expect(t.fake.args).toEqual(['-c', `wmux_chat_session="${HOST_ID}"`, 'app-server', '--listen', 'stdio://']);
    expect(t.fake.calls('thread/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write', cwd: '/tmp/x' });
    expect(t.events).toEqual([{ type: 'session.providerBound', providerSessionId: THREAD_ID }, { type: 'session.started' }]);
    await t.driver.stop();
  });

  it('refuses a bypass record, and a Codex below the measured floor', async () => {
    await expect(setup({ mode: 'bypass' }).start()).rejects.toThrow(/no bypass mode/);
    const old = setup();
    old.fake.version = '0.161.9';
    await expect(old.start()).rejects.toThrow(/0\.161\.9 is too old/);
    expect(old.fake.calls('thread/start')).toHaveLength(0);
    expect(codexVersionSupported(codexVersionFromUserAgent('wmux_chat/0.162.1 (Mac OS)'))).toBe(true);
    expect(codexVersionSupported(codexVersionFromUserAgent('wmux_chat/0.162.1-alpha.2 (Mac OS)'))).toBe(false);
    expect(codexVersionSupported(codexVersionFromUserAgent('wmux_chat (Mac OS)'))).toBe(false);
  });

  it('approves a command with accept only, once per request', async () => {
    const t = setup();
    await t.running();
    t.fake.note('item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'touch a', status: 'inProgress' } });
    t.fake.request(7, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'touch a', availableDecisions: ['accept', 'decline', 'cancel'] });
    t.fake.request(7, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'touch a' });
    await until(() => t.decisions.length > 0);
    await tick(20);
    expect(t.decisions).toEqual([expect.objectContaining({ kind: 'permission', requestId: '7', toolName: 'Shell', summary: 'touch a' })]);
    expect(t.events.filter((e) => e.type === 'approval.requested')).toEqual([expect.objectContaining({ requestId: '7', callId: 'call_1' })]);
    expect(await t.driver.answer('7', { decision: 'approve', formKind: 'permission' })).toBe('ok');
    expect(await t.driver.answer('7', { decision: 'deny', formKind: 'permission' })).toBe('not-found');
    await tick(10);
    expect(t.fake.replies(7)).toEqual([{ id: 7, result: { decision: 'accept' } }]);
    await t.driver.stop();
  });

  it('denies with decline, or with cancel (labelled as stopping the turn) where decline is not offered', async () => {
    const t = setup();
    await t.running();
    t.fake.request(1, 'item/commandExecution/requestApproval', { itemId: 'a', command: 'ls' });
    t.fake.request(2, 'item/commandExecution/requestApproval', { itemId: 'b', command: 'rm x', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } }, 'cancel'] });
    await until(() => t.decisions.length === 2);
    expect(t.decisions[0]).not.toHaveProperty('denyLabel');
    expect(t.decisions[1]).toMatchObject({ denyLabel: 'No, stop the turn' });
    await t.driver.answer('1', { decision: 'deny', formKind: 'permission' });
    await t.driver.answer('2', { decision: 'deny', formKind: 'permission' });
    await tick(10);
    expect(t.fake.replies(1)[0].result).toEqual({ decision: 'decline' });
    expect(t.fake.replies(2)[0].result).toEqual({ decision: 'cancel' });
    await t.driver.stop();
  });

  it('raises a file-change card again whenever the diff it shows is not the diff being approved', async () => {
    const t = setup();
    await t.running();
    // The approval before its item: a card at once, which approves nothing yet.
    t.fake.request(3, 'item/fileChange/requestApproval', { itemId: 'fc_1' });
    await until(() => t.decisions.length === 1);
    expect(t.decisions[0]).toMatchObject({ requestId: '3', summary: 'File changes (details loading)' });
    expect(await t.driver.answer('3', { decision: 'approve', formKind: 'permission' })).toBe('changed');
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'fc_1', status: 'inProgress', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update', move_path: null }, diff: DIFF }] } });
    await until(() => t.decisions.length === 2);
    expect(t.decisions[1]).toMatchObject({ requestId: '3', summary: '/tmp/x/a.txt +1 −1' });
    // The same diff again raises nothing; a changed one does.
    t.fake.note('item/fileChange/patchUpdated', { itemId: 'fc_1', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: DIFF }] });
    t.fake.note('item/fileChange/patchUpdated', { itemId: 'fc_1', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: `${DIFF}+more\n` }] });
    await until(() => t.decisions.length === 3);
    await tick(20);
    expect(t.decisions).toHaveLength(3);
    expect(t.decisions[2]).toMatchObject({ requestId: '3', summary: '/tmp/x/a.txt +2 −1' });
    const cards = t.events.filter((e) => e.type === 'approval.requested');
    expect(cards.at(-1)).toMatchObject({ callId: 'fc_1', preview: { kind: 'write', additions: 2, deletions: 1 } });
    expect(await t.driver.answer('3', { decision: 'approve', formKind: 'permission' })).toBe('ok');
    await tick(10);
    expect(t.fake.replies(3)).toEqual([{ id: 3, result: { decision: 'accept' } }]);
    await t.driver.stop();
  });

  it('asks before granting permissions, grants only known keys, and refuses what it cannot show in full', async () => {
    const t = setup();
    await t.running();
    t.fake.request(4, 'item/permissions/requestApproval', { itemId: 'p', cwd: '/tmp/x', permissions: { fileSystem: { write: ['/tmp/out'], read: null }, network: null } });
    t.fake.request(5, 'item/permissions/requestApproval', { itemId: 'q', cwd: '/tmp/x', permissions: { fileSystem: { write: ['/tmp/out'] }, macos: { accessibility: true } } });
    t.fake.request(6, 'item/permissions/requestApproval', { itemId: 'r', cwd: '/tmp/x', permissions: { fileSystem: { write: [`/${'d'.repeat(250)}`] } } });
    await until(() => t.fake.replies(5).length > 0 && t.fake.replies(6).length > 0);
    expect(t.decisions).toEqual([expect.objectContaining({ requestId: '4', toolName: 'Permissions', summary: 'write /tmp/out' })]);
    expect(t.fake.replies(5)[0].result).toEqual({ permissions: {}, scope: 'turn' });
    expect(t.fake.replies(6)[0].result).toEqual({ permissions: {}, scope: 'turn' });
    expect(await t.driver.answer('4', { decision: 'approve', formKind: 'permission' })).toBe('ok');
    await tick(10);
    expect(t.fake.replies(4)[0].result).toEqual({ permissions: { fileSystem: { write: ['/tmp/out'] } }, scope: 'turn' });
    expect(permissionsCard({ network: { enabled: true } })).toEqual({ ok: true, summary: 'network on', grant: { network: { enabled: true } } });
    await t.driver.stop();
  });

  it('declines what nobody can answer: requests outside a turn, other threads, and unsupported methods', async () => {
    const t = setup();
    await t.start();
    t.fake.request(8, 'item/commandExecution/requestApproval', { itemId: 'x', command: 'ls' });
    await t.driver.send({ text: 'go', attachments: [] });
    t.fake.out({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 'other', turnId: 'turn-1', itemId: 'y' } });
    t.fake.request(10, 'mcpServer/elicitation/request', { message: 'token?' });
    await until(() => [8, 9, 10].every((id) => t.fake.replies(id).length > 0));
    expect(t.fake.replies(8)[0].result).toEqual({ decision: 'decline' });
    expect(t.fake.replies(9)[0].result).toEqual({ decision: 'decline' });
    expect(t.fake.replies(10)[0]).toHaveProperty('error');
    expect(t.decisions).toHaveLength(0);
    await t.driver.stop();
  });

  it('maps a turn: deltas, a declined command, and an interrupted end that drops open cards', async () => {
    const t = setup();
    await t.running();
    t.fake.note('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
    t.fake.note('item/agentMessage/delta', { itemId: 'm1', delta: 'Hel' });
    t.fake.note('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello' } });
    t.fake.note('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'declined' } });
    t.fake.request(11, 'item/commandExecution/requestApproval', { itemId: 'c2', command: 'ls' });
    await until(() => t.decisions.length === 1);
    expect(await t.driver.interrupt()).toBe(true);
    t.fake.note('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    await until(() => t.events.some((e) => e.type === 'turn.ended'));
    expect(t.fake.calls('turn/interrupt')[0].params).toEqual({ threadId: THREAD_ID, turnId: 'turn-1' });
    const deltas = t.events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : []));
    expect(deltas.join('')).toBe('Hello');
    expect(t.events).toContainEqual({ type: 'tool.updated', callId: 'c1', status: 'failed', detail: 'Declined' });
    expect(t.gone).toEqual(['11']);
    expect(t.events.at(-1)).toEqual({ type: 'turn.ended', outcome: 'interrupted' });
    await t.driver.stop();
  });

  it('answers request_user_input with Codex ids and labels, and skips a secret question', async () => {
    const t = setup();
    await t.running();
    t.fake.request(12, 'item/tool/requestUserInput', { itemId: 'u', isBlocking: true, questions: [{ id: 'color', header: 'Color', question: 'Which?', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] });
    t.fake.request(13, 'item/tool/requestUserInput', { itemId: 'v', isBlocking: true, questions: [{ id: 'pw', header: 'Token', question: 'Token?', isSecret: true }] });
    await until(() => t.decisions.length === 1 && t.fake.replies(13).length > 0);
    expect(t.fake.replies(13)[0].result).toEqual({ answers: {} });
    expect(await t.driver.answer('12', { decision: 'approve', formKind: 'questions', answers: [{ keys: ['2'] }] })).toBe('ok');
    await tick(10);
    expect(t.fake.replies(12)[0].result).toEqual({ answers: { color: { answers: ['Blue'] } } });
    await t.driver.stop();
  });
});
