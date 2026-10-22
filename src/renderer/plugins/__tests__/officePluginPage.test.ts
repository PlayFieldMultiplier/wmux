// @vitest-environment jsdom
// The Office example plugin's page (examples/plugins/office), run as the
// sandboxed frame runs it: one room per workspace when the host sends every
// workspace, today's single room otherwise, and a click asks the host to
// focus that employee's pane.
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BUNDLE = path.resolve('examples/plugins/office');
const source = (file: string) => fs.readFileSync(path.join(BUNDLE, file), 'utf8');

interface FakePort { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; start(): void; close(): void }

beforeAll(() => {
  const html = source('index.html');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
  // Reduced motion: nobody walks, so a redraw places everyone at once.
  window.matchMedia = ((query: string) => ({ matches: true, media: query })) as unknown as typeof window.matchMedia;
  for (const file of ['sprites.js', 'layout.js', 'office.js']) new Function(source(file)).call(self);
});

/** The host's init message, with a port the test holds the other end of. */
function connect() {
  const sent: Record<string, unknown>[] = [];
  const port: FakePort = { onmessage: null, postMessage: (m) => sent.push(m as Record<string, unknown>),
    start() { /* nothing is queued on a fake port */ }, close() { /* nothing to release */ } };
  const init = new MessageEvent('message', { data: { v: 1, kind: 'init' } });
  Object.defineProperty(init, 'source', { value: window.parent });
  Object.defineProperty(init, 'ports', { value: [port] });
  window.dispatchEvent(init);
  let revision = 0;
  const state = (fields: Record<string, unknown>) =>
    port.onmessage?.({ data: { v: 1, id: null, kind: 'agent-state', epoch: 'e1', revision: ++revision, status: 'ready', ...fields } });
  return { sent, state };
}

const agent = (paneId: string, surfaceId: string, state = 'working') =>
  ({ paneId, label: paneId, state, stashed: false, surfaces: [{ surfaceId, agentName: 'Claude Code' }] });

const sections = () => [...document.querySelectorAll<HTMLElement>('#rooms > section.office')];
const heading = (s: HTMLElement) => s.querySelector<HTMLElement>('.office-name')!;
const visible = (el: HTMLElement | null) => !!el && !el.hidden;
const employees = (s: HTMLElement) => [...s.querySelectorAll<HTMLButtonElement>('button.employee')];

describe('office page', () => {
  it('draws one room per workspace and asks the host to focus a clicked employee\'s pane', () => {
    const { sent, state } = connect();
    state({ workspaceId: 'w2', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1'), agent('p2', 's2', 'needsYou')] },
      { workspaceId: 'w2', name: 'beta', truncated: false, panes: [] },
      { workspaceId: 'w3', name: 'gamma', truncated: false, panes: [agent('p3', 's3', 'resting')] },
      { workspaceId: 'w4', name: 'delta', truncated: false, panes: [] },
    ] } });

    const rooms = sections();
    expect(rooms.map((s) => heading(s).textContent)).toEqual(['alpha', 'beta · current', 'gamma', 'delta']);
    expect(rooms.map((s) => employees(s).length)).toEqual([2, 0, 1, 0]);
    expect(rooms[0].querySelector('.room')?.getAttribute('aria-label')).toBe('alpha: Office, 2 agents');
    // The workspace on screen keeps its empty office; another empty one is a line.
    expect(visible(rooms[1].querySelector('.office-floor'))).toBe(true);
    expect(visible(rooms[1].querySelector('.empty'))).toBe(true);
    expect(visible(rooms[3].querySelector('.office-floor'))).toBe(false);
    expect(visible(rooms[3].querySelector('.office-idle'))).toBe(true);

    employees(rooms[2])[0].click();
    expect(sent.at(-1)).toMatchObject({ v: 1, kind: 'request', method: 'pane.focus', params: { id: 'p3' } });
    expect(employees(rooms[2])[0].disabled).toBe(true);
  });

  it('keeps rooms across updates: a closed workspace leaves, a new one joins in order, seats stay', () => {
    const { state } = connect();
    const w1 = { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1')] };
    const w2 = { workspaceId: 'w2', name: 'beta', truncated: false, panes: [agent('p2', 's2')] };
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [w1, w2] } });
    const alpha = sections()[0];
    const seat = employees(alpha)[0].style.left;

    const w0 = { workspaceId: 'w0', name: 'new', truncated: false, panes: [agent('p0', 's0')] };
    state({ workspaceId: 'w2', allWorkspaces: { truncated: false, workspaces: [w0, w1] } });
    expect(sections().map((s) => heading(s).firstChild?.textContent)).toEqual(['new', 'alpha']);
    // Same room element and seat for alpha; the switch moved only the marker.
    expect(sections()[1]).toBe(alpha);
    expect(employees(alpha)[0].style.left).toBe(seat);
    expect(heading(alpha).textContent).toBe('alpha');
  });

  it('falls back to today\'s single room when the host sends one workspace', () => {
    const { sent, state } = connect();
    state({ workspaceId: 'w1', snapshot: { workspaceId: 'w1', truncated: false, panes: [agent('p1', 's1'), agent('p2', 's2')] } });
    const rooms = sections();
    expect(rooms).toHaveLength(1);
    expect(visible(heading(rooms[0]))).toBe(false);
    expect(rooms[0].querySelector('.room')?.getAttribute('aria-label')).toBe('Office, 2 agents');
    employees(rooms[0])[1].click();
    expect(sent.at(-1)).toMatchObject({ method: 'pane.focus', params: { id: 'p2' } });
  });

  it('clears every room on reset', () => {
    const { state } = connect();
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1')] },
      { workspaceId: 'w2', name: 'beta', truncated: false, panes: [agent('p2', 's2')] },
    ] } });
    state({ status: 'reset', workspaceId: 'w1' });
    expect(sections()).toHaveLength(1);
    expect(employees(sections()[0])).toHaveLength(0);
    expect(document.querySelector('#notice')?.textContent).toBe('Loading workspace…');
  });
});
