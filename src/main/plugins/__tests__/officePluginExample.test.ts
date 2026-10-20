// The Office example plugin (examples/plugins/office): its bundle loads, and
// its pure layout script keeps everyone in place across snapshots.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { PluginHostLoader } from '../PluginHostLoader';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';

const BUNDLE = path.resolve('examples/plugins/office');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

interface Pane { paneId: string; label: string; state: string; stashed: boolean; surfaces: { surfaceId: string; agentName: string }[] }
interface Employee { id: string; paneId: string; label: string; agent: string; state: string; stashed: boolean; look: number }
interface Seat { x: number; y: number; z: number; spot: string }
interface Layout {
  width: number; height: number; desks: Seat[]; queue: Seat[]; lounge: Seat[]; queueRows: number;
  deskFor: Record<string, number>; queueFor: Record<string, number>; loungeFor: Record<string, number>;
  props: { key: string }[];
}
interface OfficeLayoutApi {
  DESK_COLUMNS: number; BASE_DESK_ROWS: number; QUEUE_COLUMNS: number; BASE_SOFAS: number;
  employeesFromSnapshot(snapshot: { panes: Pane[] }): Employee[];
  layoutOffice(employees: Pick<Employee, 'id' | 'state'>[], prev?: Layout): Layout;
  spotFor(employee: Pick<Employee, 'id' | 'state'>, layout: Layout): { kind: string; key: string } | null;
}

/** layout.js is a classic browser script; run it as the page would. */
function loadLayout(): OfficeLayoutApi {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(BUNDLE, 'layout.js'), 'utf8'), context);
  return (context as { OfficeLayout: OfficeLayoutApi }).OfficeLayout;
}

const office = loadLayout();
const emp = (id: string, state = 'working') => ({ id, state });
/** Queued ids in queue order. */
const line = (layout: Layout) => Object.keys(layout.queueFor).sort((x, y) => layout.queueFor[x] - layout.queueFor[y]);

describe('office example bundle', () => {
  it('loads with exactly the reviewed permissions and every file the page references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-office-plugin-'));
    roots.push(root);
    fs.cpSync(BUNDLE, path.join(root, 'office'), { recursive: true });
    const trust = {
      upsertDeclaration: vi.fn(async (name: string) => ({ name, status: 'unconfirmed' })),
      get: vi.fn(async () => undefined),
    } as unknown as PluginTrustStore;
    const loader = new PluginHostLoader(trust, root);
    await loader.loadAll();

    expect(loader.listFailures()).toEqual([]);
    const manifest = loader.get('office')?.manifest;
    expect(manifest?.capabilities).toEqual(['ui.rail-page', 'agent.state.read', 'pane.read']);
    expect(manifest?.contributes.railPage).toEqual({ title: 'Office', entry: 'index.html', agentStateEvents: true });

    const html = fs.readFileSync(path.join(BUNDLE, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(['sprites.js', 'layout.js', 'office.js']);
    for (const file of [...scripts, 'characters.png', 'furniture.png', 'README.md', 'LICENSE']) {
      expect(loader.resolveBundlePath('office', file), file).not.toBeNull();
    }
  });
});

describe('office layout', () => {
  it('makes one employee per agent surface, carrying its pane state and label', () => {
    const employees = office.employeesFromSnapshot({ panes: [
      { paneId: 'p1', label: 'api', state: 'needsYou', stashed: false, surfaces: [
        { surfaceId: 's1', agentName: 'Claude Code' }, { surfaceId: 's2', agentName: 'Codex' }] },
      { paneId: 'p2', label: 'web', state: 'resting', stashed: true, surfaces: [{ surfaceId: 's3', agentName: 'Codex' }] },
      { paneId: 'p3', label: 'web', state: 'working', stashed: false, surfaces: [{ surfaceId: 's4', agentName: 'Codex' }] },
      { paneId: 'p4', label: 'x', state: 'bogus', stashed: false, surfaces: [{ surfaceId: 's5', agentName: 'Codex' }] },
    ] });
    expect(employees.map((e) => [e.id, e.paneId, e.state, e.stashed])).toEqual([
      ['s1', 'p1', 'needsYou', false], ['s2', 'p1', 'needsYou', false],
      ['s3', 'p2', 'resting', true], ['s4', 'p3', 'working', false],
    ]);
    // Same label: the agent is added, then a number where that still collides.
    expect(employees.map((e) => e.label)).toEqual(['api · Claude Code', 'api · Codex', 'web · Codex · 1', 'web · Codex · 2']);
  });

  it('lays out 30 employees with distinct desks and sofa spots inside the room', () => {
    const states = ['working', 'needsYou', 'finished', 'resting'];
    const employees = Array.from({ length: 30 }, (_, i) => emp(`s${i}`, states[i % 4]));
    const layout = office.layoutOffice(employees);
    const desks = employees.map((e) => layout.deskFor[e.id]);
    expect(new Set(desks).size).toBe(30);
    expect(layout.desks.length).toBe(Math.ceil(30 / office.DESK_COLUMNS) * office.DESK_COLUMNS);
    const resting = employees.filter((e) => e.state === 'resting');
    expect(new Set(resting.map((e) => layout.loungeFor[e.id])).size).toBe(resting.length);
    for (const seat of [...layout.desks, ...layout.lounge, ...layout.queue]) {
      expect(seat.x).toBeGreaterThan(0);
      expect(seat.x).toBeLessThan(layout.width);
      expect(seat.y).toBeGreaterThan(0);
      expect(seat.y).toBeLessThan(layout.height);
    }
    for (const e of employees) {
      expect(office.spotFor(e, layout)?.kind).toBe(e.state === 'working' ? 'desk' : e.state === 'resting' ? 'sofa' : 'queue');
    }
  });

  it('keeps desks across snapshots; a newcomer takes a freed desk', () => {
    const first = office.layoutOffice([emp('a'), emp('b'), emp('c'), emp('d')]);
    const second = office.layoutOffice([emp('d'), emp('e'), emp('a'), emp('c', 'resting')], first);
    expect(second.deskFor.a).toBe(first.deskFor.a);
    expect(second.deskFor.c).toBe(first.deskFor.c);
    expect(second.deskFor.d).toBe(first.deskFor.d);
    expect(second.deskFor.e).toBe(first.deskFor.b);
  });

  it('queues needs-you first, then finished on a row of their own, each in arrival order', () => {
    const first = office.layoutOffice([emp('f1', 'finished'), emp('n1', 'needsYou'), emp('w')]);
    expect(line(first)).toEqual(['n1', 'f1']);
    expect(first.queueFor.f1).toBe(office.QUEUE_COLUMNS);
    // n2 arrives behind n1 even though it is listed first; f1 keeps its place.
    const second = office.layoutOffice([emp('n2', 'needsYou'), emp('f1', 'finished'), emp('n1', 'needsYou'), emp('w')], first);
    expect(line(second)).toEqual(['n1', 'n2', 'f1']);
    // n1 leaves the queue and comes back: it joins the back of its group.
    const third = office.layoutOffice([emp('n1'), emp('n2', 'needsYou'), emp('f1', 'finished')], second);
    const fourth = office.layoutOffice([emp('n1', 'needsYou'), emp('n2', 'needsYou'), emp('f1', 'finished')], third);
    expect(line(fourth)).toEqual(['n2', 'n1', 'f1']);
  });

  it('grows the queue area but never shrinks it while the page is open', () => {
    const many = Array.from({ length: 13 }, (_, i) => emp(`n${i}`, 'needsYou'));
    const grown = office.layoutOffice(many);
    expect(grown.queueRows).toBe(Math.ceil(13 / office.QUEUE_COLUMNS));
    const after = office.layoutOffice([emp('n0', 'needsYou')], grown);
    expect(after.queueRows).toBe(grown.queueRows);
  });

  it('sizes the lounge to the resting count and keeps each sofa spot', () => {
    const rest = (id: string) => emp(id, 'resting');
    const sofas = (layout: Layout) => layout.props.filter((p) => p.key === 'sofa').length;
    expect(sofas(office.layoutOffice([rest('a')]))).toBe(office.BASE_SOFAS);
    const big = office.layoutOffice(Array.from({ length: 25 }, (_, i) => rest(`r${i}`)));
    expect(sofas(big)).toBe(13);
    const first = office.layoutOffice([rest('a'), rest('b'), rest('c')]);
    const second = office.layoutOffice([emp('a'), rest('b'), rest('c'), rest('d')], first);
    expect(second.loungeFor.b).toBe(first.loungeFor.b);
    expect(second.loungeFor.c).toBe(first.loungeFor.c);
    expect(second.loungeFor.d).toBe(first.loungeFor.a);
  });
});
