import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { CodexDriver } from '../codex/codexDriver';
import { codexVersionFromUserAgent, codexVersionSupported, permissionsCard } from '../codex/codexProtocol';
import type { ChatV2DriverDecision, ChatV2DriverSink, ChatV2DriverStart } from '../types';
import { FakeCodex, THREAD_ID } from './fakeCodex';
import { tick, until } from './fakeClaude';

const HOST_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CHAT_ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f60718293';

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
    chatSessionId: CHAT_ID,
    ...spec,
  }, sink);
  const running = async () => {
    await start();
    await driver.send({ text: 'go', attachments: [] });
  };
  /** The revision of the latest card raised for a request. */
  const revision = (requestId: string) => {
    const d = decisions.filter((x) => x.requestId === requestId).at(-1);
    return d?.kind === 'permission' ? d.revision : undefined;
  };
  const approve = (requestId: string, rev = revision(requestId)) => driver.answer(requestId, { decision: 'approve', formKind: 'permission', revision: rev });
  return { fake, driver, events, decisions, gone, start, running, revision, approve };
}

const DIFF = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';

describe('CodexDriver', () => {
  it('starts app-server with the chat record id as the argv marker and an explicit on-request thread', async () => {
    const t = setup();
    await t.start();
    // Not the provider session id: a new thread is bound to Codex's own id.
    expect(t.fake.args).toEqual(['-c', `wmux_chat_session="${CHAT_ID}"`, 'app-server', '--listen', 'stdio://']);
    expect(t.driver.marker).toBe(CHAT_ID);
    expect(t.fake.calls('thread/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write', cwd: '/tmp/x' });
    expect(t.events).toEqual([{ type: 'session.providerBound', providerSessionId: THREAD_ID }, { type: 'session.started' }]);
    await t.driver.stop();
    await expect(setup({ chatSessionId: 'x" -c evil="1' }).start()).rejects.toThrow(/chat record id/);
    await expect(setup({ chatSessionId: undefined }).start()).rejects.toThrow(/chat record id/);
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
    // Codex's version is the one after our client name; ours is only in the parentheses.
    expect(codexVersionFromUserAgent('wmux_chat/0.162.1 (Mac OS 15.6.0; arm64) dumb (wmux_chat; 1.0.0)')).toBe('0.162.1');
    expect(codexVersionFromUserAgent('codex_cli/0.170.0 (Mac OS)')).toBeNull();
    expect(codexVersionFromUserAgent('wmux_chat/0.170.0x')).toBeNull();
  });

  it('refuses to resume a thread that does not list its turns, or lists one still running', async () => {
    const resume = { providerSession: { id: THREAD_ID, mode: 'resume' as const } };
    const unlisted = setup(resume);
    unlisted.fake.resumeTurns = undefined;
    await expect(unlisted.start()).rejects.toThrow(/did not say whether/);
    const running = setup(resume);
    running.fake.resumeTurns = [{ id: 't1', status: 'completed' }, { id: 't2', status: 'inProgress' }];
    await expect(running.start()).rejects.toThrow(/still running somewhere else/);
    const idle = setup(resume);
    idle.fake.resumeTurns = [{ id: 't1', status: 'completed' }];
    await idle.start();
    await idle.driver.stop();
  });

  it('approves a command with accept only, once per request, and only with the card\'s revision', async () => {
    const t = setup();
    await t.running();
    t.fake.note('item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'touch a', status: 'inProgress' } });
    t.fake.request(7, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'touch a', availableDecisions: ['accept', 'decline', 'cancel'] });
    await until(() => t.decisions.length > 0);
    expect(t.decisions).toEqual([expect.objectContaining({ kind: 'permission', requestId: '7', toolName: 'Shell', summary: 'touch a', revision: expect.any(String) })]);
    expect(t.events.filter((e) => e.type === 'approval.requested')).toEqual([expect.objectContaining({ requestId: '7', callId: 'call_1' })]);
    expect(await t.driver.answer('7', { decision: 'approve', formKind: 'permission' })).toBe('changed');
    expect(await t.approve('7')).toBe('ok');
    expect(await t.driver.answer('7', { decision: 'deny', formKind: 'permission' })).toBe('not-found');
    // The same id again: declined, never a second card.
    t.fake.request(7, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'touch b' });
    await until(() => t.fake.replies(7).length === 2);
    expect(t.fake.replies(7)).toEqual([{ id: 7, result: { decision: 'accept' } }, { id: 7, result: { decision: 'decline' } }]);
    expect(t.decisions).toHaveLength(1);
    await t.driver.stop();
  });

  it('keeps a number id and the same digits as a string apart, and network approvals name the command', async () => {
    const t = setup();
    await t.running();
    t.fake.request(5, 'item/commandExecution/requestApproval', { itemId: 'a', command: 'ls' });
    t.fake.request('5', 'item/commandExecution/requestApproval', { itemId: 'b', command: 'curl example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' } });
    await until(() => t.decisions.length === 2);
    expect(t.decisions.map((d) => d.requestId)).toEqual(['5', 's:5']);
    expect(t.decisions[1]).toMatchObject({ summary: 'Network access to example.com (https): curl example.com' });
    expect(await t.approve('s:5')).toBe('ok');
    await tick(10);
    expect(t.fake.replies('5')).toEqual([{ id: '5', result: { decision: 'accept' } }]);
    expect(t.fake.replies(5)).toEqual([]);
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
    expect(await t.approve('3')).toBe('changed');
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'fc_1', status: 'inProgress', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update', move_path: null }, diff: DIFF }] } });
    await until(() => t.decisions.length === 2);
    expect(t.decisions[1]).toMatchObject({ requestId: '3', summary: 'a.txt +1 −1' });
    const seen = t.revision('3');
    // The same diff again raises nothing; a changed one does.
    t.fake.note('item/fileChange/patchUpdated', { itemId: 'fc_1', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: DIFF }] });
    t.fake.note('item/fileChange/patchUpdated', { itemId: 'fc_1', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: `${DIFF}+more\n` }] });
    await until(() => t.decisions.length === 3);
    await tick(20);
    expect(t.decisions).toHaveLength(3);
    expect(t.decisions[2]).toMatchObject({ requestId: '3', summary: 'a.txt +2 −1' });
    const cards = t.events.filter((e) => e.type === 'approval.requested');
    expect(cards.at(-1)).toMatchObject({ callId: 'fc_1', preview: { kind: 'write', additions: 2, deletions: 1 } });
    // An approve given on the card before the change lands on nothing.
    expect(await t.approve('3', seen)).toBe('changed');
    expect(t.fake.replies(3)).toEqual([]);
    expect(await t.approve('3')).toBe('ok');
    await tick(10);
    expect(t.fake.replies(3)).toEqual([{ id: 3, result: { decision: 'accept' } }]);
    await t.driver.stop();
  });

  it('declines file changes it cannot read or list in full, and shows a move\'s destination', async () => {
    const t = setup();
    await t.running();
    const update = (path: string) => ({ path, kind: { type: 'update', move_path: null }, diff: DIFF });
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'many', status: 'inProgress', changes: Array.from({ length: 12 }, (_, i) => update(`/tmp/x/src/some/deeper/folder/file-${i}.ts`)) } });
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'odd', status: 'inProgress', changes: [update('/tmp/x/a.txt'), { path: '/tmp/x/b.txt', kind: { type: 'rename' }, diff: '' }] } });
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'mv', status: 'inProgress', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update', move_path: '/tmp/x/b.txt' }, diff: DIFF }] } });
    t.fake.request(20, 'item/fileChange/requestApproval', { itemId: 'many' });
    t.fake.request(21, 'item/fileChange/requestApproval', { itemId: 'odd' });
    t.fake.request(22, 'item/fileChange/requestApproval', { itemId: 'mv' });
    await until(() => t.fake.replies(20).length > 0 && t.fake.replies(21).length > 0 && t.decisions.some((d) => d.requestId === '22'));
    expect(t.fake.replies(20)[0].result).toEqual({ decision: 'decline' });
    expect(t.fake.replies(21)[0].result).toEqual({ decision: 'decline' });
    expect(t.decisions.find((d) => d.requestId === '22')).toMatchObject({ summary: 'a.txt → b.txt +1 −1' });
    expect(t.events.filter((e) => e.type === 'status').map((e) => (e as { text: string }).text)).toEqual([
      expect.stringContaining('change 12 files at once'),
      expect.stringContaining('cannot read'),
    ]);
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
    expect(await t.approve('4')).toBe('ok');
    await tick(10);
    expect(t.fake.replies(4)[0].result).toEqual({ permissions: { fileSystem: { write: ['/tmp/out'] } }, scope: 'turn' });
    expect(permissionsCard({ network: { enabled: true } })).toEqual({ ok: true, summary: 'network on', grant: { network: { enabled: true } } });
    await t.driver.stop();
  });

  it('grants a sandbox entry only as the card shows it', () => {
    const entry = { access: 'write', path: { type: 'path', path: '/tmp/out' } };
    expect(permissionsCard({ fileSystem: { entries: [entry, { access: 'read', path: { type: 'special', value: { kind: 'project_roots', subpath: 'docs' } } }], globScanMaxDepth: 3 } })).toEqual({
      ok: true,
      summary: 'write /tmp/out; read (project_roots docs); glob scan depth 3',
      grant: { fileSystem: { entries: [entry, { access: 'read', path: { type: 'special', value: { kind: 'project_roots', subpath: 'docs' } } }], globScanMaxDepth: 3 } },
    });
    // Anything the line would not show refuses the request.
    for (const bad of [
      { ...entry, recursive: true },
      { access: 'write', path: { type: 'path', path: '/tmp/out', followLinks: true } },
      { access: 'admin', path: { type: 'path', path: '/tmp/out' } },
      { access: 'read', path: { type: 'special', value: { kind: 'unknown', path: '/etc' } } },
      { access: 'read', path: { type: 'special', value: { kind: 'root', subpath: 'x' } } },
    ]) expect(permissionsCard({ fileSystem: { entries: [bad] } }), JSON.stringify(bad)).toMatchObject({ ok: false });
    expect(permissionsCard({ fileSystem: { write: ['/tmp/out'], globScanMaxDepth: 0 } })).toMatchObject({ ok: false });
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
    // The request the turn left behind is still answered, with the reply that grants nothing.
    await until(() => t.fake.replies(11).length > 0);
    expect(t.fake.replies(11)).toEqual([{ id: 11, result: { decision: 'decline' } }]);
    expect(t.events.at(-1)).toEqual({ type: 'turn.ended', outcome: 'interrupted' });
    await t.driver.stop();
  });

  it('keeps one turn at a time: a second send is refused and a late end of an earlier turn ends nothing', async () => {
    const t = setup();
    await t.running();
    await expect(t.driver.send({ text: 'again', attachments: [] })).rejects.toThrow(/still running/);
    t.fake.note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await until(() => t.events.some((e) => e.type === 'turn.ended'));
    await t.driver.send({ text: 'next', attachments: [] });
    const ended = () => t.events.filter((e) => e.type === 'turn.ended').length;
    // turn-1's notifications arriving late: none reaches turn-2.
    t.fake.out({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed' } } });
    t.fake.out({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: 'turn-1', itemId: 'old', delta: 'stale' } });
    t.fake.out({ id: 30, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD_ID, turnId: 'turn-1', itemId: 'c', command: 'ls' } });
    await until(() => t.fake.replies(30).length > 0);
    await tick(20);
    expect(ended()).toBe(1);
    expect(t.events.some((e) => e.type === 'message.delta' && e.text === 'stale')).toBe(false);
    expect(t.fake.replies(30)[0].result).toEqual({ decision: 'decline' });
    t.fake.note('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    await until(() => ended() === 2);
    await t.driver.stop();
  });

  it('stops a turn that has no id yet once it gets one, and says true only when the stop went out', async () => {
    const t = setup();
    await t.start();
    t.fake.turnStart = 'hold';
    const sent = t.driver.send({ text: 'go', attachments: [] });
    await until(() => t.fake.calls('turn/start').length === 1);
    let stopped: boolean | undefined;
    const stopping = t.driver.interrupt().then((v) => { stopped = v; });
    await tick(20);
    expect(stopped).toBeUndefined();
    expect(t.fake.calls('turn/interrupt')).toHaveLength(0);
    t.fake.answerTurnStart();
    await sent;
    await stopping;
    expect(stopped).toBe(true);
    expect(t.fake.calls('turn/interrupt')[0].params).toEqual({ threadId: THREAD_ID, turnId: 'turn-1' });
    await t.driver.stop();
  });

  it('a turn/start refused starts nothing; one answered without an id stops the process', async () => {
    const refused = setup();
    await refused.start();
    refused.fake.turnStart = 'refuse';
    await expect(refused.driver.send({ text: 'go', attachments: [] })).rejects.toThrow(/bad input/);
    expect(refused.fake.exited).toBe(false);
    refused.fake.turnStart = 'id';
    await refused.driver.send({ text: 'again', attachments: [] });
    await refused.driver.stop();
    const unnamed = setup();
    await unnamed.start();
    unnamed.fake.turnStart = 'noId';
    await expect(unnamed.driver.send({ text: 'go', attachments: [] })).rejects.toThrow(/without naming it/);
    await until(() => unnamed.fake.exited);
  });

  it('a file-change card whose approve failed to send is raised again when its diff moved meanwhile', async () => {
    const t = setup();
    await t.running();
    t.fake.note('item/started', { item: { type: 'fileChange', id: 'fc', status: 'inProgress', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: DIFF }] } });
    t.fake.request(40, 'item/fileChange/requestApproval', { itemId: 'fc' });
    await until(() => t.decisions.length === 1);
    t.fake.failWrite = (line) => line.id === 40;
    const answered = t.approve('40');
    t.fake.note('item/fileChange/patchUpdated', { itemId: 'fc', changes: [{ path: '/tmp/x/a.txt', kind: { type: 'update' }, diff: `${DIFF}+more\n` }] });
    expect(await answered).toBe('uncertain');
    expect(t.decisions).toHaveLength(2);
    expect(t.decisions[1]).toMatchObject({ requestId: '40', summary: 'a.txt +2 −1' });
    expect(t.decisions[1]).not.toMatchObject({ revision: (t.decisions[0] as { revision?: string }).revision });
    await t.driver.stop();
  });

  it('answers request_user_input with Codex ids and labels, and skips a secret question', async () => {
    const t = setup();
    await t.running();
    t.fake.request(12, 'item/tool/requestUserInput', { itemId: 'u', isBlocking: true, questions: [{ id: 'color', header: 'Color', question: 'Which?', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] });
    t.fake.request(13, 'item/tool/requestUserInput', { itemId: 'v', isBlocking: true, questions: [{ id: 'pw', header: 'Token', question: 'Token?', isSecret: true }] });
    t.fake.request(14, 'item/tool/requestUserInput', { itemId: 'w', isBlocking: true, questions: [{ id: 'pw', header: 'Token', question: 'Token?', isSecret: 'yes' }] });
    await until(() => t.decisions.length === 1 && t.fake.replies(13).length > 0 && t.fake.replies(14).length > 0);
    expect(t.fake.replies(13)[0].result).toEqual({ answers: {} });
    expect(t.fake.replies(14)[0].result).toEqual({ answers: {} });
    expect(await t.driver.answer('12', { decision: 'approve', formKind: 'questions', answers: [{ keys: ['2'] }] })).toBe('ok');
    await tick(10);
    expect(t.fake.replies(12)[0].result).toEqual({ answers: { color: { answers: ['Blue'] } } });
    await t.driver.stop();
  });
});
