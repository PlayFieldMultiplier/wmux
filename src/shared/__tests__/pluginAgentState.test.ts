import { describe, expect, it } from 'vitest';
import {
  PLUGIN_AGENT_MAX_WORKSPACES,
  parsePluginAgentSnapshot,
  parsePluginAllAgentSnapshot,
} from '../pluginAgentState';

const pane = (paneId: string, extra: Record<string, unknown> = {}) => ({
  paneId, label: `label ${paneId}`, state: 'working', stashed: false,
  surfaces: [{ surfaceId: `s-${paneId}`, agentName: 'Claude Code' }], ...extra,
});

describe('parsePluginAllAgentSnapshot', () => {
  it('rebuilds a multi-workspace payload from allowed fields only', () => {
    const raw = {
      truncated: false,
      secret: 'top-level extra',
      workspaces: [
        { workspaceId: 'w1', name: 'alpha', truncated: false, cwd: 'C:\\private', panes: [pane('p1', { activity: '$ SECRET=1', title: 'x' })] },
        { workspaceId: 'w2', name: 'beta', truncated: true, panes: [] },
        { workspaceId: 'w3', name: 'gamma', truncated: false, panes: [pane('p3', { state: 'needsYou' }), pane('p4', { state: 'resting', stashed: true })] },
      ],
    };
    expect(parsePluginAllAgentSnapshot(raw)).toEqual({
      truncated: false,
      workspaces: [
        { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [{ paneId: 'p1', label: 'label p1', state: 'working', stashed: false, surfaces: [{ surfaceId: 's-p1', agentName: 'Claude Code' }] }] },
        { workspaceId: 'w2', name: 'beta', truncated: true, panes: [] },
        { workspaceId: 'w3', name: 'gamma', truncated: false, panes: [
          { paneId: 'p3', label: 'label p3', state: 'needsYou', stashed: false, surfaces: [{ surfaceId: 's-p3', agentName: 'Claude Code' }] },
          { paneId: 'p4', label: 'label p4', state: 'resting', stashed: true, surfaces: [{ surfaceId: 's-p4', agentName: 'Claude Code' }] },
        ] },
      ],
    });
    // Activity is never part of the all-workspaces projection.
    expect(JSON.stringify(parsePluginAllAgentSnapshot(raw))).not.toContain('SECRET');
  });

  it('refuses malformed, duplicated and oversized workspace lists', () => {
    const ws = (workspaceId: unknown, name: unknown = 'n') => ({ workspaceId, name, truncated: false, panes: [] });
    expect(() => parsePluginAllAgentSnapshot(null)).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [] })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: {}, truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [ws('w1'), ws('w1')], truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [ws('')], truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [ws(7)], truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [{ ...ws('w1'), name: undefined }], truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [ws('w1', 'x'.repeat(513))], truncated: false })).toThrow();
    expect(() => parsePluginAllAgentSnapshot({ workspaces: [{ ...ws('w1'), panes: [pane('p', { state: 'bogus' })] }], truncated: false })).toThrow();
    const many = Array.from({ length: PLUGIN_AGENT_MAX_WORKSPACES + 1 }, (_, i) => ws(`w${i}`));
    expect(() => parsePluginAllAgentSnapshot({ workspaces: many, truncated: true })).toThrow();
    expect(parsePluginAllAgentSnapshot({ workspaces: many.slice(1), truncated: true }).workspaces).toHaveLength(PLUGIN_AGENT_MAX_WORKSPACES);
  });

  it('refuses a payload over the byte limit', () => {
    const big = Array.from({ length: 100 }, (_, w) => ({
      workspaceId: `w${w}`, name: 'n', truncated: false,
      panes: Array.from({ length: 30 }, (_, p) => pane(`p${w}-${p}`, { label: 'L'.repeat(512) })),
    }));
    expect(() => parsePluginAllAgentSnapshot({ workspaces: big, truncated: false })).toThrow('exceeds limit');
  });
});

describe('parsePluginAgentSnapshot (unchanged by the all-workspaces parser)', () => {
  it('still pins the workspace and keeps activity only when asked', () => {
    const raw = { workspaceId: 'w1', truncated: false, panes: [pane('p1', { activity: 'npm test' })] };
    expect(parsePluginAgentSnapshot(raw, 'w1', true).panes[0].activity).toBe('npm test');
    expect(parsePluginAgentSnapshot(raw, 'w1', false).panes[0]).not.toHaveProperty('activity');
    expect(() => parsePluginAgentSnapshot(raw, 'w2', false)).toThrow();
  });
});
