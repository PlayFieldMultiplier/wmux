import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { clearForgeHostsCache, forgeHosts } from '../forgeHosts';

describe('forgeHosts (the CLIs\' config files)', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-forge-'));
    fs.mkdirSync(path.join(dir, 'gh'));
    fs.mkdirSync(path.join(dir, 'glab'));
    vi.stubEnv('GH_CONFIG_DIR', path.join(dir, 'gh'));
    vi.stubEnv('GLAB_CONFIG_DIR', path.join(dir, 'glab'));
    clearForgeHostsCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearForgeHostsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads gh\'s hosts.yml and glab\'s config.yml from their config dirs', () => {
    fs.writeFileSync(path.join(dir, 'gh', 'hosts.yml'), 'code.acme.example:\n    user: alice\n');
    fs.writeFileSync(path.join(dir, 'glab', 'config.yml'), 'hosts:\n    gitlab.example.com:\n        subfolder: gitlab\n');
    const hosts = forgeHosts(0);
    expect([...hosts.gh]).toEqual(['code.acme.example']);
    expect(hosts.glab.get('gitlab.example.com')).toEqual({ name: 'gitlab.example.com', subfolder: 'gitlab' });
  });

  it('missing files are no signal; a changed file is read again after the check interval', () => {
    expect(forgeHosts(0)).toEqual({ gh: new Set(), glab: new Map() });
    fs.writeFileSync(path.join(dir, 'gh', 'hosts.yml'), 'code.acme.example:\n    user: alice\n');
    // Within the interval the cached answer stands.
    expect(forgeHosts(1_000).gh.size).toBe(0);
    expect([...forgeHosts(20_000).gh]).toEqual(['code.acme.example']);
  });
});
