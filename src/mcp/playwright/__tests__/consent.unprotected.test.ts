import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unprotected panes on the MCP lane: allowDangerous / allowSensitiveDomains no
// longer skip a check on their own, and a download is not handed over, until
// the operator allows it through the same consent prompt protected panes use.
// A refusal (denied, timed out, nobody to ask) runs nothing. Calls that skip
// no check never ask.

const { mockSendRpc, getPage, isolated, waitIsolated, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  isolated: vi.fn(async (): Promise<unknown> => 'ran'),
  waitIsolated: vi.fn(async () => undefined),
  resolveRef: vi.fn(),
}));

const PROTECTED = { protected: true, epoch: 3, hosts: { mode: 'allowlist', allow: ['a.test', 'gmail.com'], block: [] } };
let policy: unknown = { protected: false };

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 't', policy });
    if (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get') return Promise.resolve({ token: null });
    return mockSendRpc(method, ...args);
  },
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend: vi.fn(), isLiveWriteConfined: async () => false }),
  },
}));
vi.mock('../snapshot', () => ({
  resolveRef,
  generateSnapshot: vi.fn(),
  generateScopedSnapshot: vi.fn(),
  markDomRefsActive: vi.fn(),
}));
vi.mock('../isolated-eval', () => ({ evaluateIsolated: isolated, waitForIsolated: waitIsolated }));
vi.mock('../user-gesture', () => ({ evaluateWithGesture: vi.fn() }));

import { registerInspectionTools } from '../tools/inspection';
import { registerStateTools } from '../tools/state';
import { registerFileTools } from '../tools/file';
import { claimNextDownload, guardUnclaimedDownloads } from '../downloadGuard';
import { registerWaitTools } from '../tools/wait';
import { resetProtectionMemoryForTests } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => tools.set(name, h) } as never;
const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') } as never;
registerInspectionTools(server, deps);
registerStateTools(server, deps);
registerFileTools(server, deps);
registerWaitTools(
  { registerTool: (name: string, _c: unknown, h: ToolHandler) => tools.set(name, h) } as never,
  deps,
  { profile: 'full', context: { principal: { kind: 'unattributed' } } } as never,
);
const tool = (name: string) => tools.get(name) as ToolHandler;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

const consentCalls = () => mockSendRpc.mock.calls.filter(([m]) => m === 'browser.consent.request');

function allow() {
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.consent.request') return { ok: true, operationId: 'op-1', epoch: 0, via: 'once' };
    return {};
  });
}

function refuse(message: string) {
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.consent.request') throw new Error(message);
    return {};
  });
}

// What main answers when the operator says no, does not answer in time, or
// cannot be shown the question.
const REFUSALS = [
  "browser.consent.request: policy_denied: the operator denied it. Skipping this safety check needs the operator's consent; do not retry unchanged.",
  "browser.consent.request: policy_denied: the operator did not answer in time. Skipping this safety check needs the operator's consent; do not retry unchanged.",
  "browser.consent.request: policy_denied: nobody can be asked right now. Skipping this safety check needs the operator's consent; do not retry unchanged.",
];

beforeEach(() => {
  vi.clearAllMocks();
  policy = { protected: false };
  resetProtectionMemoryForTests();
  __resetSurfaceRoutingForTesting();
});

describe('browser_evaluate on an unprotected pane', () => {
  const page = { url: () => 'http://a.test/x' };
  beforeEach(() => getPage.mockResolvedValue(page));

  it('a script that trips no pattern runs without asking', async () => {
    allow();
    const out = await tool('browser_evaluate')({ expression: 'document.title', allowDangerous: true, surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(0);
    expect(isolated).toHaveBeenCalledTimes(1);
  });

  it('a blocked pattern without allowDangerous is blocked and asks nobody', async () => {
    allow();
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('Pass allowDangerous:true to ask the user');
    expect(consentCalls()).toHaveLength(0);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('allowDangerous asks the operator about this script, then runs it', async () => {
    allow();
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toMatchObject({
      action: 'evaluate',
      url: 'http://a.test/x',
      detail: 'fetch("/x")',
      unprotected: true,
    });
    expect(isolated).toHaveBeenCalledTimes(1);
  });

  it.each(REFUSALS)('without consent the script never runs: %s', async (message) => {
    refuse(message);
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied:/);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('a transport failure (main not there to ask) is a refusal too', async () => {
    refuse('connect ENOENT');
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied: browser_evaluate needs the operator's consent to skip this safety check/);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('an unattended run gets needs_consent and nothing runs', async () => {
    refuse('browser.consent.request: needs_consent: evaluate on a.test. This is a scheduled run and nobody is there to answer.');
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(text(out)).toMatch(/^needs_consent:/);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('a page that moved to another site under the prompt is refused', async () => {
    let url = 'http://a.test/x';
    getPage.mockResolvedValue({ url: () => url });
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.consent.request') {
        url = 'http://b.test/';
        return { ok: true, operationId: 'op', epoch: 0 };
      }
      return {};
    });
    const out = await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('a protected pane is unchanged: it asks on its own terms, never as unprotected', async () => {
    policy = PROTECTED;
    allow();
    await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).not.toHaveProperty('unprotected');
  });
});

describe('browser_cookies on an unprotected pane', () => {
  const cookies = [
    { name: 'a', value: 'A', domain: 'a.test', path: '/' },
    { name: 'm', value: 'SECRET', domain: '.gmail.com', path: '/' },
  ];
  const context = { cookies: vi.fn(async () => cookies), addCookies: vi.fn(), clearCookies: vi.fn() };
  beforeEach(() => getPage.mockResolvedValue({ url: () => 'http://a.test/', context: () => context }));

  it('without the flag sensitive values stay redacted and nobody is asked', async () => {
    allow();
    const out = await tool('browser_cookies')({ action: 'get', surfaceId: 's1' });
    expect(text(out)).toContain('<REDACTED sensitive-domain>');
    expect(text(out)).not.toContain('SECRET"');
    expect(consentCalls()).toHaveLength(0);
  });

  it('allowSensitiveDomains asks for the sensitive sites it would reveal, then reveals them', async () => {
    allow();
    const out = await tool('browser_cookies')({ action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toMatchObject({ action: 'sensitive', hosts: ['gmail.com'], unprotected: true });
    expect(text(out)).toContain('"SECRET"');
  });

  it('a sensitive url is named in the question', async () => {
    allow();
    await tool('browser_cookies')({ action: 'get', url: 'https://mail.naver.com/', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(consentCalls()[0][1]).toMatchObject({ action: 'sensitive', hosts: ['mail.naver.com', 'gmail.com'] });
  });

  it.each(REFUSALS)('a refusal reveals nothing: %s', async (message) => {
    refuse(message);
    const out = await tool('browser_cookies')({ action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied:/);
    expect(text(out)).not.toContain('SECRET"');
  });

  it('the flag with no sensitive site in reach asks nobody', async () => {
    context.cookies.mockResolvedValueOnce([cookies[0]]);
    allow();
    const out = await tool('browser_cookies')({ action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(0);
  });
});

describe('browser_storage on an unprotected pane', () => {
  // Storage is read in the isolated world (evaluateIsolated, mocked above).
  const evaluate = isolated;
  beforeEach(() => getPage.mockResolvedValue({ url: () => 'https://mail.naver.com/inbox' }));

  it('a sensitive page with the flag asks first, then reads, checking the host in the same evaluation', async () => {
    allow();
    isolated.mockResolvedValueOnce({ href: 'https://mail.naver.com/inbox', value: { k: 'SECRETV' } });
    const out = await tool('browser_storage')({ type: 'local', action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()[0][1]).toMatchObject({ action: 'sensitive', hosts: ['mail.naver.com'], unprotected: true });
    expect(evaluate).toHaveBeenCalled();
    expect(text(out)).toContain('SECRETV');
    expect(text(out)).not.toContain('href');
  });

  it('a read that lands on another site than the approved one returns nothing', async () => {
    allow();
    isolated.mockResolvedValueOnce({ href: 'https://other.test/', value: { k: 'SECRETV' } });
    const out = await tool('browser_storage')({ type: 'local', action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied: .*moved to another site/);
    expect(text(out)).not.toContain('SECRETV');
  });

  it('with the flag, a page address that cannot be read is refused, not read as safe', async () => {
    getPage.mockResolvedValue({ url: () => '' });
    allow();
    const out = await tool('browser_storage')({ type: 'local', action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied: .*could not be read/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a refusal reads nothing', async () => {
    refuse(REFUSALS[0]);
    const out = await tool('browser_storage')({ type: 'local', action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a page that is not sensitive reads without asking', async () => {
    getPage.mockResolvedValue({ url: () => 'https://a.test/' });
    allow();
    const out = await tool('browser_storage')({ type: 'local', action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(0);
  });
});

describe('downloads on an unprotected pane', () => {
  function makeDownload(url = 'https://cdn.test/files/report.csv') {
    return {
      url: () => url,
      suggestedFilename: () => 'report.csv',
      path: vi.fn(async () => '/tmp/playwright-artifacts/abc'),
      saveAs: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
  }
  let download: ReturnType<typeof makeDownload>;
  const click = vi.fn(async () => undefined);
  beforeEach(() => {
    download = makeDownload();
    getPage.mockResolvedValue({ url: () => 'https://app.test/', waitForEvent: vi.fn(async () => download) });
    resolveRef.mockResolvedValue({ click });
  });

  it('browser_download asks naming the host and the file name, then hands the file over', async () => {
    allow();
    const out = await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toMatchObject({
      action: 'download',
      url: 'https://cdn.test/files/report.csv',
      detail: 'report.csv',
      unprotected: true,
    });
    expect(consentCalls()[0][1]).not.toHaveProperty('targetId');
    expect(text(out)).toContain('Downloaded:');
    expect(download.cancel).not.toHaveBeenCalled();
  });

  it.each(REFUSALS)('browser_download without consent cancels and deletes the file: %s', async (message) => {
    refuse(message);
    const out = await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied:/);
    expect(text(out)).not.toContain('Downloaded:');
    expect(download.cancel).toHaveBeenCalled();
    expect(download.delete).toHaveBeenCalled();
    expect(download.path).not.toHaveBeenCalled();
  });

  it('a blob download is named by the origin that made it', async () => {
    download = makeDownload('blob:https://app.test/0b1c');
    allow();
    await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(consentCalls()[0][1]).toMatchObject({ url: 'https://app.test' });
  });

  it('browser_wait_for_download asks too, and a refusal is reported as itself', async () => {
    refuse(REFUSALS[1]);
    const out = await tool('browser_wait_for_download')({ surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied: .*did not answer in time/);
    expect(download.delete).toHaveBeenCalled();
    expect(download.path).not.toHaveBeenCalled();
  });

  it('browser_wait_for_download with a filename mismatch cancels and deletes the file', async () => {
    allow();
    const out = await tool('browser_wait_for_download')({ filename: 'other.csv', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('filename mismatch');
    expect(download.cancel).toHaveBeenCalled();
    expect(download.delete).toHaveBeenCalled();
    expect(consentCalls()).toHaveLength(0);
  });

  it('browser_wait_for_download with consent reports the file', async () => {
    allow();
    const out = await tool('browser_wait_for_download')({ surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()[0][1]).toMatchObject({ action: 'download', detail: 'report.csv', unprotected: true });
    expect(JSON.parse(text(out))).toMatchObject({ suggestedFilename: 'report.csv' });
  });
});

describe('browser_wait fn on an unprotected pane', () => {
  beforeEach(() => getPage.mockResolvedValue({ url: () => 'http://a.test/x', waitForURL: vi.fn(async () => undefined) }));

  it('a predicate that trips no pattern runs without asking', async () => {
    allow();
    const out = await tool('browser_wait')({ fn: '() => window.ready', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(0);
    expect(waitIsolated).toHaveBeenCalledTimes(1);
  });

  it('a blocked pattern asks the operator first, then polls', async () => {
    allow();
    const out = await tool('browser_wait')({ fn: '() => document.cookie.length > 0', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toMatchObject({
      action: 'evaluate',
      url: 'http://a.test/x',
      detail: '() => document.cookie.length > 0',
      unprotected: true,
    });
    expect(waitIsolated).toHaveBeenCalledTimes(1);
  });

  it.each(REFUSALS)('without consent the predicate never runs: %s', async (message) => {
    refuse(message);
    const out = await tool('browser_wait')({ fn: '() => document.cookie.length > 0', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^policy_denied:/);
    expect(waitIsolated).not.toHaveBeenCalled();
  });

  it('a fn next to a url is never evaluated, so nobody is asked', async () => {
    allow();
    const out = await tool('browser_wait')({ url: '**/x', fn: '() => document.cookie', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(0);
  });
});

describe('downloads no download tool asked for, on an unprotected pane', () => {
  function emitterPage() {
    const listeners: Array<(d: unknown) => void> = [];
    return {
      page: { on: (_e: string, l: (d: unknown) => void) => listeners.push(l) },
      emit: (d: unknown) => listeners.forEach((l) => l(d)),
      count: () => listeners.length,
    };
  }
  function fakeDownload() {
    return { url: () => 'https://cdn.test/x.bin', cancel: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('an unclaimed download (a click, a key press, a navigation) is cancelled and deleted', async () => {
    const { page, emit } = emitterPage();
    guardUnclaimedDownloads(page as never);
    const d = fakeDownload();
    emit(d);
    await flush();
    expect(d.cancel).toHaveBeenCalled();
    expect(d.delete).toHaveBeenCalled();
  });

  it('a claim lets exactly one download through; the next is cancelled', async () => {
    const { page, emit } = emitterPage();
    guardUnclaimedDownloads(page as never);
    claimNextDownload(page as never);
    const first = fakeDownload();
    const second = fakeDownload();
    emit(first);
    emit(second);
    await flush();
    expect(first.cancel).not.toHaveBeenCalled();
    expect(second.cancel).toHaveBeenCalled();
  });

  it('a released claim (no download arrived) lets nothing through later', async () => {
    const { page, emit } = emitterPage();
    guardUnclaimedDownloads(page as never);
    const release = claimNextDownload(page as never);
    release();
    const d = fakeDownload();
    emit(d);
    await flush();
    expect(d.cancel).toHaveBeenCalled();
  });

  it('arming is idempotent', () => {
    const { page, count } = emitterPage();
    guardUnclaimedDownloads(page as never);
    guardUnclaimedDownloads(page as never);
    expect(count()).toBe(1);
  });

  it('browser_download arms the guard and its own download wins the race', async () => {
    const { page: emitter, emit } = emitterPage();
    const own = { ...fakeDownload(), suggestedFilename: () => 'x.bin', path: vi.fn(async () => '/tmp/a'), saveAs: vi.fn() };
    const page = {
      ...emitter,
      url: () => 'https://app.test/',
      // The browser emits to every listener in the order they were added: the
      // guard first, then the tool's own wait.
      waitForEvent: vi.fn(() => new Promise((resolve) => setTimeout(() => {
        emit(own);
        resolve(own);
      }, 0))),
    };
    getPage.mockResolvedValue(page);
    resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });
    allow();
    const out = await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(own.cancel).not.toHaveBeenCalled();
    // A later download nobody asked for is cancelled.
    const stray = fakeDownload();
    emit(stray);
    await flush();
    expect(stray.cancel).toHaveBeenCalled();
    expect(stray.delete).toHaveBeenCalled();
  });
});
