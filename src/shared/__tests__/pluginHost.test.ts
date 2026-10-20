import { describe, it, expect } from 'vitest';
import {
  parseBridgeRequest,
  parsePluginManifest,
  requiredUiCapabilities,
  PLUGIN_NAME_REGEX,
} from '../pluginHost';

describe('parseBridgeRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(parseBridgeRequest({ v: 1, id: 'r1', kind: 'request', method: 'pane.list' })).toEqual({
      v: 1, id: 'r1', kind: 'request', method: 'pane.list', params: undefined,
    });
  });

  it('accepts params objects and rejects non-object params', () => {
    expect(parseBridgeRequest({ v: 1, id: 'r1', kind: 'request', method: 'm', params: { a: 1 } })?.params).toEqual({ a: 1 });
    expect(parseBridgeRequest({ v: 1, id: 'r1', kind: 'request', method: 'm', params: [1] })).toBeNull();
    expect(parseBridgeRequest({ v: 1, id: 'r1', kind: 'request', method: 'm', params: 'x' })).toBeNull();
  });

  it('rejects wrong version, kind, and malformed ids/methods', () => {
    expect(parseBridgeRequest({ v: 2, id: 'r', kind: 'request', method: 'm' })).toBeNull();
    expect(parseBridgeRequest({ v: 1, id: 'r', kind: 'response', method: 'm' })).toBeNull();
    expect(parseBridgeRequest({ v: 1, id: '', kind: 'request', method: 'm' })).toBeNull();
    expect(parseBridgeRequest({ v: 1, id: 'r', kind: 'request', method: '' })).toBeNull();
    expect(parseBridgeRequest({ v: 1, id: 'x'.repeat(200), kind: 'request', method: 'm' })).toBeNull();
    expect(parseBridgeRequest(null)).toBeNull();
    expect(parseBridgeRequest('str')).toBeNull();
  });
});

const VALID_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  capabilities: ['ui.sidebar', 'workspace.read'],
  activationEvents: ['onStartup'],
  contributes: { sidebar: { title: 'Demo', entry: 'panel.html' } },
};

describe('parsePluginManifest', () => {
  it('accepts a valid manifest', () => {
    const r = parsePluginManifest(VALID_MANIFEST);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe('demo-plugin');
      expect(r.manifest.contributes.sidebar).toEqual({ title: 'Demo', entry: 'panel.html' });
    }
  });

  it('rejects invalid names', () => {
    for (const name of ['UPPER', '../x', 'a b', '', 'x'.repeat(80)]) {
      const r = parsePluginManifest({ ...VALID_MANIFEST, name });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects unsafe entry paths', () => {
    for (const entry of ['../escape.html', '/abs.html', 'a\\b.html', 'http://x', 'a:b']) {
      const r = parsePluginManifest({
        ...VALID_MANIFEST,
        contributes: { sidebar: { title: 'T', entry } },
      });
      expect(r.ok, `entry ${entry} should be rejected`).toBe(false);
    }
  });

  it('rejects invalid activation events and accepts the frozen grammar', () => {
    expect(parsePluginManifest({ ...VALID_MANIFEST, activationEvents: ['onBoot'] }).ok).toBe(false);
    expect(parsePluginManifest({ ...VALID_MANIFEST, activationEvents: ['onAgentDetected:'] }).ok).toBe(false);
    expect(parsePluginManifest({
      ...VALID_MANIFEST,
      activationEvents: ['onStartup', 'onWorkspace', 'onAgentDetected:claude', 'onEvent:notification.received'],
    }).ok).toBe(true);
  });

  it('validates statusbar and commands contributions', () => {
    const r = parsePluginManifest({
      ...VALID_MANIFEST,
      capabilities: ['ui.statusbar', 'ui.commands'],
      contributes: {
        statusbar: { entry: 'widget.html', alignment: 'left' },
        commands: [{ id: 'do-thing', title: 'Do Thing' }],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.contributes.statusbar?.alignment).toBe('left');
      expect(r.manifest.contributes.commands).toEqual([{ id: 'do-thing', title: 'Do Thing' }]);
    }
    expect(parsePluginManifest({
      ...VALID_MANIFEST,
      contributes: { statusbar: { entry: 'w.html', alignment: 'center' } },
    }).ok).toBe(false);
    expect(parsePluginManifest({
      ...VALID_MANIFEST,
      contributes: { commands: [{ id: 'Bad ID', title: 'x' }] },
    }).ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(parsePluginManifest(null).ok).toBe(false);
    expect(parsePluginManifest([]).ok).toBe(false);
    expect(parsePluginManifest('{}').ok).toBe(false);
  });
});

describe('requiredUiCapabilities', () => {
  it('maps contributions to their gating capabilities', () => {
    expect(requiredUiCapabilities({
      sidebar: { title: 'T', entry: 'a.html' },
      statusbar: { entry: 'b.html' },
      paneDecoration: {},
      commands: [{ id: 'c', title: 'C' }],
    }).sort()).toEqual(['ui.commands', 'ui.pane-decoration', 'ui.sidebar', 'ui.statusbar']);
    expect(requiredUiCapabilities({})).toEqual([]);
    expect(requiredUiCapabilities({ commands: [] })).toEqual([]);
  });
});

describe('PLUGIN_NAME_REGEX', () => {
  it('matches the host segment charset only', () => {
    expect(PLUGIN_NAME_REGEX.test('my-plugin.v2_x')).toBe(true);
    expect(PLUGIN_NAME_REGEX.test('-leading')).toBe(false);
    expect(PLUGIN_NAME_REGEX.test('has/slash')).toBe(false);
  });
});

describe('rail page contribution', () => {
  it('requires both page and state capabilities for an event page', () => {
    const result = parsePluginManifest({ ...VALID_MANIFEST, contributes: { railPage: { title: 'Agents', entry: 'page.html', agentStateEvents: true } } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(requiredUiCapabilities(result.manifest.contributes)).toEqual(['ui.rail-page', 'agent.state.read']);
  });
  it.each(['../bad.html', '/abs.html', 'C:\\page.html', 'https://example.test'])('rejects unsafe rail entry %s', (entry) => {
    expect(parsePluginManifest({ ...VALID_MANIFEST, contributes: { railPage: { title: 'Agents', entry } } }).ok).toBe(false);
  });
  it('rejects a non-boolean event opt-in', () => {
    expect(parsePluginManifest({ ...VALID_MANIFEST, contributes: { railPage: { title: 'Agents', entry: 'page.html', agentStateEvents: 'yes' } } }).ok).toBe(false);
  });
});
