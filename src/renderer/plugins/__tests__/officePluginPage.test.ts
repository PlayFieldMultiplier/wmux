// @vitest-environment jsdom
// The Office example plugin's page (examples/plugins/office), run as the
// sandboxed frame runs it: one room with every workspace's agents when the
// host sends every workspace, the one workspace otherwise, the room scaled to
// fit the page, and a click asks the host to focus that employee's pane.
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BUNDLE = path.resolve('examples/plugins/office');
const source = (file: string) => fs.readFileSync(path.join(BUNDLE, file), 'utf8');

interface FakePort { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; start(): void; close(): void }

/** jsdom does no layout: these give the page and the room the sizes a browser would. */
let pageSize = { width: 0, height: 0 };

beforeAll(() => {
  const html = source('index.html');
  document.head.innerHTML = html.slice(html.indexOf('<style>'), html.indexOf('</style>') + '</style>'.length);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
  // Reduced motion: nobody walks, so a redraw places everyone at once.
  window.matchMedia = ((query: string) => ({ matches: true, media: query })) as unknown as typeof window.matchMedia;
  // jsdom has no canvas; the backdrop is a picture and nothing here reads it.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  const page = document.querySelector<HTMLElement>('#page')!;
  Object.defineProperty(page, 'clientWidth', { get: () => pageSize.width });
  Object.defineProperty(page, 'clientHeight', { get: () => pageSize.height });
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

const agent = (paneId: string, surfaceId: string, state = 'working', label = paneId) =>
  ({ paneId, label, state, stashed: false, surfaces: [{ surfaceId, agentName: 'Claude Code' }] });

const room = () => document.querySelector<HTMLElement>('#room')!;
const employees = () => [...document.querySelectorAll<HTMLButtonElement>('#employees button.employee')];
const names = () => employees().map((b) => b.querySelector('.tag span')?.textContent);
const empty = () => document.querySelector<HTMLElement>('#empty')!;

describe('office page', () => {
  it('seats every workspace\'s agents in one room and focuses a clicked employee\'s pane', () => {
    const { sent, state } = connect();
    state({ workspaceId: 'w2', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1'), agent('p2', 's2', 'needsYou')] },
      { workspaceId: 'w2', name: 'beta', truncated: false, panes: [] },
      { workspaceId: 'w3', name: 'gamma', truncated: false, panes: [agent('p3', 's3', 'resting')] },
    ] } });

    expect(document.querySelectorAll('#room')).toHaveLength(1);
    expect(names()).toEqual(['p1', 'p2', 'p3']);
    expect(room().getAttribute('aria-label')).toBe('Office, 3 agents');
    expect(employees()[2].getAttribute('aria-label')).toBe('p3, Claude Code in gamma: Resting');
    expect(employees()[2].querySelector('.agent')?.textContent).toBe(' · gamma · Claude Code');
    expect(empty().hidden).toBe(true);

    employees()[2].click();
    expect(sent.at(-1)).toMatchObject({ v: 1, kind: 'request', method: 'pane.focus', params: { id: 'p3' } });
    expect(employees()[2].disabled).toBe(true);
  });

  it('tells same-named panes in different workspaces apart by workspace', () => {
    const { state } = connect();
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1', 'working', 'build')] },
      { workspaceId: 'w2', name: 'beta', truncated: false, panes: [agent('p2', 's2', 'working', 'build'), agent('p3', 's3', 'working', 'tests')] },
    ] } });
    expect(names()).toEqual(['build · alpha', 'build · beta', 'tests']);
  });

  it('keeps everyone\'s seat when the host switches workspace or another workspace changes', () => {
    const { state } = connect();
    const w1 = { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1')] };
    const w2 = { workspaceId: 'w2', name: 'beta', truncated: false, panes: [agent('p2', 's2')] };
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [w1, w2] } });
    const seat = employees()[0].style.left;

    const w0 = { workspaceId: 'w0', name: 'new', truncated: false, panes: [agent('p0', 's0')] };
    state({ workspaceId: 'w2', allWorkspaces: { truncated: false, workspaces: [w0, w1] } });
    expect(names()).toEqual(['p1', 'p0']);
    expect(employees()[0].style.left).toBe(seat);
  });

  it('says no workspace has agents when none does, and falls back to the one workspace without the grant', () => {
    const { sent, state } = connect();
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [{ workspaceId: 'w1', name: 'alpha', truncated: false, panes: [] }] } });
    expect(empty().hidden).toBe(false);
    expect(document.querySelector('#empty-title')?.textContent).toBe('No local agents in any workspace');

    state({ workspaceId: 'w1', snapshot: { workspaceId: 'w1', truncated: false, panes: [agent('p1', 's1'), agent('p2', 's2')] } });
    expect(room().getAttribute('aria-label')).toBe('Office, 2 agents');
    expect(employees()[1].querySelector('.agent')?.textContent).toBe(' · Claude Code');
    employees()[1].click();
    expect(sent.at(-1)).toMatchObject({ method: 'pane.focus', params: { id: 'p2' } });

    state({ workspaceId: 'w1', snapshot: { workspaceId: 'w1', truncated: false, panes: [] } });
    expect(document.querySelector('#empty-title')?.textContent).toBe('No local agents in this workspace');
  });

  it('notes a size cut in any workspace', () => {
    const { state } = connect();
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: true, panes: [agent('p1', 's1')] },
    ] } });
    expect(document.querySelector('#notice')?.textContent).toBe('Some agents were omitted by the size limit.');
  });

  it('scales the room to fit the page, with names held at a readable size', () => {
    const { state } = connect();
    pageSize = { width: 600, height: 400 };
    window.dispatchEvent(new Event('resize'));
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1')] },
    ] } });
    const fit = Number(room().style.getPropertyValue('--fit'));
    const width = parseFloat(room().style.width);
    const height = parseFloat(room().style.height);
    // The page's padding is 12px 16px (index.html), read through getComputedStyle.
    expect(fit).toBeCloseTo(Math.min((600 - 32) / width, (400 - 24) / height), 6);
    const stage = document.querySelector<HTMLElement>('#stage')!;
    expect(parseFloat(stage.style.width)).toBeCloseTo(width * fit, 3);
    expect(parseFloat(stage.style.height)).toBeCloseTo(height * fit, 3);
    expect(fit).toBeLessThan(0.8);
    // Below 0.8 the names stop shrinking: their own scale times the room's is 0.8.
    expect(Number(room().style.getPropertyValue('--text')) * fit).toBeCloseTo(0.8, 6);

    // A larger page grows the room; names are never drawn above their own size.
    pageSize = { width: 4000, height: 3000 };
    window.dispatchEvent(new Event('resize'));
    const grown = Number(room().style.getPropertyValue('--fit'));
    expect(grown).toBeGreaterThan(1);
    expect(Number(room().style.getPropertyValue('--text')) * grown).toBeCloseTo(1, 6);
  });

  it('clears the room on reset', () => {
    const { state } = connect();
    state({ workspaceId: 'w1', allWorkspaces: { truncated: false, workspaces: [
      { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [agent('p1', 's1')] },
    ] } });
    state({ status: 'reset', workspaceId: 'w1' });
    expect(employees()).toHaveLength(0);
    expect(document.querySelector('#notice')?.textContent).toBe('Loading workspace…');
  });
});
