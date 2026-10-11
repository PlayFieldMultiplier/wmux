import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import {
  CodeToolRefusal,
  assertCodeToolAllowed,
  resetProtectionMemoryForTests,
} from '../../playwright/automationLease';
import { lastKnownProtection } from '../../playwright/browserScope';
import { createReplToolCatalog } from '../tools';
import { disposeReplRegistry, getReplRegistry } from '../replRegistry';
import { createBrowserReplCatalog, disposeBrowserRepl } from '../../browser-repl/tool';

// browser_repl and repl_run run caller-supplied code in the MCP process, where
// no browser check reaches it. On a protected pane they are refused, and they
// run only when main explicitly answers that the calling pane is unprotected.

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };
const gate = (tool: string) => assertCodeToolAllowed(deps, tool);
const PROTECTED = { protected: true, epoch: 3, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] } };

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function acquireAnswers(acquire: () => unknown) {
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return acquire();
    return Promise.resolve({});
  });
}

function textOf(result: unknown): string {
  return ((result as Result).content ?? []).map((c) => c.text ?? '').join('\n');
}

const UNKNOWN_ANSWERS: Array<[string, () => unknown]> = [
  ['a transport failure', () => Promise.reject(new Error('Connection error: ECONNRESET'))],
  ['a reply with no policy (a main that predates authorization)', () => Promise.resolve({ token: null })],
  ['a reply whose policy is unreadable', () => Promise.resolve({ token: null, policy: { protected: 'yes' } })],
];

beforeEach(() => {
  mockSendRpc.mockReset();
  deps.resolveWorkspaceId.mockReset();
  deps.resolveWorkspaceId.mockImplementation(async () => 'ws-test');
  resetProtectionMemoryForTests();
});

afterEach(() => {
  disposeReplRegistry();
  disposeBrowserRepl();
});

describe('assertCodeToolAllowed', () => {
  it('asks main for an authorization-only answer: the workspace, no surface, authorize:true', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: { protected: false } }));
    await expect(gate('repl_run')).resolves.toBeUndefined();
    expect(mockSendRpc).toHaveBeenCalledWith('browser.lease.acquire', { workspaceId: 'ws-test', authorize: true });
  });

  it('refuses a protected pane, saying the pane is protected', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: PROTECTED }));
    const refusal = await gate('repl_run').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(CodeToolRefusal);
    expect(refusal).toMatchObject({ code: 'policy_denied', paneProtected: true });
    expect((refusal as Error).message).toContain('repl_run is not available on a protected pane');
    expect(lastKnownProtection('ws-test')).toBe(true);
  });

  it("refuses when main's gate denies the call outright", async () => {
    acquireAnswers(() =>
      Promise.reject(new Error('browser.lease.acquire: policy_denied: the calling pane could not be identified. Do not retry')),
    );
    await expect(gate('browser_repl')).rejects.toMatchObject({ code: 'policy_denied', paneProtected: true });
  });

  it.each(UNKNOWN_ANSWERS)('refuses on %s', async (_label, acquire) => {
    acquireAnswers(acquire);
    const refusal = await gate('repl_run').catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'policy_denied', paneProtected: false });
    expect((refusal as Error).message).toContain('could not confirm');
  });

  it('refuses on a transport failure even when the pane was last answered unprotected', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: { protected: false } }));
    await gate('repl_run');
    acquireAnswers(() => Promise.reject(new Error('Connection error: ECONNRESET')));
    await expect(gate('repl_run')).rejects.toMatchObject({ paneProtected: false });
  });

  it('refuses when the caller has no workspace identity', async () => {
    deps.resolveWorkspaceId.mockImplementation(async () => {
      throw new Error('WORKSPACE_SCOPE_UNRESOLVED: no identity');
    });
    await expect(gate('repl_run')).rejects.toMatchObject({ paneProtected: false });
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('hands back a lease an older main granted for the unnamed acquire', async () => {
    acquireAnswers(() => Promise.resolve({ token: 'stray' }));
    await expect(gate('repl_run')).rejects.toBeInstanceOf(CodeToolRefusal);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.lease.release', { token: 'stray' });
  });
});

describe('repl_run on a protected pane', () => {
  const run = () =>
    createReplToolCatalog(gate)[0].invoke({ code: '40 + 2' }, {} as never) as Promise<Result>;

  it('is refused before a runtime is started', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: PROTECTED }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('repl_run is not available on a protected pane');
    expect(getReplRegistry().list()).toHaveLength(0);
  });

  it.each(UNKNOWN_ANSWERS)('is refused on %s', async (_label, acquire) => {
    acquireAnswers(acquire);
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('could not confirm');
    expect(getReplRegistry().list()).toHaveLength(0);
  });

  it('runs on an unprotected pane exactly as before, and a later protected answer ends that runtime', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: { protected: false } }));
    const ok = await run();
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('42');
    expect(getReplRegistry().list()).toHaveLength(1);

    acquireAnswers(() => Promise.resolve({ token: null, policy: PROTECTED }));
    const refused = await run();
    expect(refused.isError).toBe(true);
    // A runtime started before the pane was protected does not outlive it.
    expect(getReplRegistry().list()).toHaveLength(0);
  }, 30_000);

  it('repl_reset and repl_sessions ask nothing of main: they run no code', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: PROTECTED }));
    const [, reset, sessions] = createReplToolCatalog(gate);
    expect((await reset.invoke({}, {} as never)) as Result).not.toMatchObject({ isError: true });
    expect((await sessions.invoke({}, {} as never)) as Result).not.toMatchObject({ isError: true });
    expect(mockSendRpc).not.toHaveBeenCalled();
  });
});

describe('browser_repl on a protected pane', () => {
  const run = () =>
    createBrowserReplCatalog(new Map(), gate)[0].invoke(
      { code: '40 + 2' },
      { principal: { kind: 'unattributed' } },
    ) as Promise<Result>;

  it('is refused before a runtime is started', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: PROTECTED }));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('browser_repl is not available on a protected pane');
    expect(textOf(result)).not.toContain('started a new runtime');
  });

  it.each(UNKNOWN_ANSWERS)('is refused on %s', async (_label, acquire) => {
    acquireAnswers(acquire);
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('could not confirm');
  });

  it('runs on an unprotected pane exactly as before', async () => {
    acquireAnswers(() => Promise.resolve({ token: null, policy: { protected: false } }));
    const result = await run();
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('browser_repl · ok');
    expect(textOf(result)).toContain('42');
  }, 30_000);
});
