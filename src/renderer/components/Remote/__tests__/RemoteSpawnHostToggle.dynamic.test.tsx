// @vitest-environment jsdom
//
// The Remote page's per-PC slot for starting new agents: nothing while the
// feature flag is off; with it on, the toggle reads and writes only
// `hosts[hostId].allowed` of the whole policy, and a refused save reaches the
// row. Root ids for allowed folders stay inside the contract's pattern.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSpawnPolicy, isSpawnRootId, type A2aSpawnPolicyV1 } from '../../../../shared/a2aSpawn';
import RemoteSpawnHostToggle from '../RemoteSpawnHostToggle';
import { makeRootId } from '../remoteSpawnPolicy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const policy = (): A2aSpawnPolicyV1 => ({ ...defaultSpawnPolicy(), enabled: true, hosts: { [OTHER]: { allowed: true } }, version: 4 });

describe('RemoteSpawnHostToggle', () => {
  it('renders nothing while the flag is off, or before the policy is read', async () => {
    const onSave = vi.fn();
    await act(async () => root.render(<RemoteSpawnHostToggle hostId={HOST} name="DESK" policy={policy()} onSave={onSave} onError={vi.fn()} />));
    expect(container.innerHTML).toBe('');
    await act(async () => root.render(<RemoteSpawnHostToggle enabled hostId={HOST} name="DESK" policy={null} onSave={onSave} onError={vi.fn()} />));
    expect(container.innerHTML).toBe('');
  });

  it('is off for a PC never opted in, and writes hosts[hostId].allowed on the whole policy', async () => {
    const before = policy();
    const onSave = vi.fn(async (next: A2aSpawnPolicyV1) => ({ ok: true as const, policy: next }));
    await act(async () => root.render(<RemoteSpawnHostToggle enabled hostId={HOST} name="DESK" policy={before} onSave={onSave} onError={vi.fn()} />));
    const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(box.getAttribute('aria-label')).toBe('DESK can start agents here');
    await act(async () => { box.click(); });
    expect(onSave).toHaveBeenCalledWith({ ...before, hosts: { [OTHER]: { allowed: true }, [HOST]: { allowed: true } } });
  });

  it('hands a refused save to the row', async () => {
    const onError = vi.fn();
    const onSave = vi.fn(async () => ({ ok: false as const, error: 'the daemon is not connected' }));
    await act(async () => root.render(<RemoteSpawnHostToggle enabled hostId={OTHER} name="LAB" policy={policy()} onSave={onSave} onError={onError} />));
    const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    expect(box.getAttribute('aria-checked')).toBe('true');
    await act(async () => { box.click(); });
    expect(onError).toHaveBeenCalledWith('the daemon is not connected');
  });
});

describe('makeRootId', () => {
  it('slugs a folder name and keeps ids unique within 32 characters', () => {
    expect(makeRootId('My API', [])).toBe('my-api');
    expect(makeRootId('프로젝트', [])).toBe('folder');
    expect(makeRootId('api', ['api', 'api-2'])).toBe('api-3');
    const long = 'a'.repeat(40);
    const first = makeRootId(long, []);
    const second = makeRootId(long, [first]);
    expect(first).toHaveLength(32);
    expect(second).not.toBe(first);
    for (const id of [first, second, makeRootId('-x-', [])]) expect(isSpawnRootId(id)).toBe(true);
  });
});
