import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { configuredForge, dropGlabSubfolder, glabConfigPath, glabEntryFor, parseGhHosts, parseGlabHosts, type ForgeHosts } from '../forgeHosts';
import { isGithubPullUrl, isMergeRequestUrl, isWorktaskPrUrl } from '../workTask';

const GH_HOSTS = `github.com:
    users:
        alice:
    git_protocol: https
    user: alice
Code.Acme.Example:
    git_protocol: ssh
    user: alice
`;

const GLAB_CONFIG = `git_protocol: ssh
host: gitlab.com
hosts:
    gitlab.com:
        api_protocol: https
        token: glpat-secret
    gitlab.example.com:8443:
        api_protocol: https
    sub.example.com:
        subfolder: /gitlab/
    two.example.com:8443:
        api_protocol: https
    two.example.com:9443:
        api_protocol: https
`;

const hostsOf = (gh: string, glab: string): ForgeHosts => ({ gh: parseGhHosts(gh), glab: parseGlabHosts(glab) });

describe('parseGhHosts / parseGlabHosts', () => {
  it('reads host names (lowercased) and a subfolder, nothing else', () => {
    expect([...parseGhHosts(GH_HOSTS)]).toEqual(['github.com', 'code.acme.example']);
    const glab = parseGlabHosts(GLAB_CONFIG);
    expect([...glab.keys()]).toEqual(['gitlab.com', 'gitlab.example.com:8443', 'sub.example.com', 'two.example.com:8443', 'two.example.com:9443']);
    expect(glab.get('sub.example.com')).toEqual({ name: 'sub.example.com', subfolder: 'gitlab' });
    expect(JSON.stringify([...glab.values()])).not.toContain('glpat');
  });

  it('an unreadable file is no signal', () => {
    expect(parseGhHosts(': : :\n\t- [')).toEqual(new Set());
    expect(parseGlabHosts('hosts: [1, 2]')).toEqual(new Map());
    expect(parseGlabHosts('')).toEqual(new Map());
  });
});

describe('glabEntryFor', () => {
  const hosts = hostsOf('', GLAB_CONFIG);

  it('the exact entry, else the one host:port entry; two ports choose none', () => {
    expect(glabEntryFor('gitlab.com', hosts)?.name).toBe('gitlab.com');
    expect(glabEntryFor('gitlab.example.com', hosts)?.name).toBe('gitlab.example.com:8443');
    expect(glabEntryFor('two.example.com', hosts)).toBeNull();
    expect(glabEntryFor('code.acme.example', hosts)).toBeNull();
  });
});

describe('dropGlabSubfolder', () => {
  const hosts = hostsOf('', 'hosts:\n    gitlab.example.com:\n        subfolder: apps/gitlab\n');

  it('drops a leading subfolder with a project left after it, in any case; anything else stays', () => {
    expect(dropGlabSubfolder('gitlab.example.com', ['Apps', 'GitLab', 'group', 'proj'], hosts)).toEqual(['group', 'proj']);
    expect(dropGlabSubfolder('gitlab.example.com', ['apps', 'gitlab', 'proj'], hosts)).toEqual(['apps', 'gitlab', 'proj']);
    expect(dropGlabSubfolder('gitlab.example.com', ['group', 'proj'], hosts)).toEqual(['group', 'proj']);
    expect(dropGlabSubfolder('other.example.com', ['apps', 'gitlab', 'group', 'proj'], hosts)).toEqual(['apps', 'gitlab', 'group', 'proj']);
  });
});

describe('glabConfigPath — the one file glab reads, in its order', () => {
  const home = os.homedir();
  const legacy = path.join(home, '.config', 'glab-cli', 'config.yml');
  const none = () => false;

  it('GLAB_CONFIG_DIR, then an existing legacy file, then XDG_CONFIG_HOME, then the platform dir', () => {
    expect(glabConfigPath({ GLAB_CONFIG_DIR: '/g', XDG_CONFIG_HOME: '/x' }, () => true)).toBe(path.join('/g', 'config.yml'));
    expect(glabConfigPath({ XDG_CONFIG_HOME: '/x' }, (f) => f === legacy)).toBe(legacy);
    // XDG is glab's choice even before its file exists: no fall-through to another file.
    expect(glabConfigPath({ XDG_CONFIG_HOME: '/x' }, none)).toBe(path.join('/x', 'glab-cli', 'config.yml'));
    const platform = glabConfigPath({ APPDATA: '/appdata' }, none);
    if (process.platform === 'darwin') expect(platform).toBe(path.join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml'));
    else expect([legacy, path.join('/appdata', 'glab-cli', 'config.yml')]).toContain(platform);
  });
});

describe('configuredForge', () => {
  it('gh only → github, glab only → gitlab, neither or both → no signal', () => {
    const hosts = hostsOf(GH_HOSTS, GLAB_CONFIG);
    expect(configuredForge('code.acme.example', hosts)).toBe('github');
    expect(configuredForge('github.com', hosts)).toBe('github');
    expect(configuredForge('gitlab.example.com', hosts)).toBe('gitlab');
    expect(configuredForge('gitlab.com', hosts)).toBe('gitlab');
    expect(configuredForge('elsewhere.example', hosts)).toBeNull();
    expect(configuredForge('gitlab.com', hostsOf('gitlab.com:\n    user: x\n', GLAB_CONFIG))).toBeNull();
  });
});

describe('task prUrl shapes', () => {
  const ghe = new Set(['code.acme.example']);

  it('a pull request page counts on github.com or a host gh is signed in to', () => {
    expect(isGithubPullUrl('https://github.com/acme/widget/pull/3')).toBe(true);
    expect(isGithubPullUrl('https://code.acme.example/acme/widget/pull/3')).toBe(false);
    expect(isGithubPullUrl('https://code.acme.example/acme/widget/pull/3', ghe)).toBe(true);
    expect(isGithubPullUrl('https://CODE.acme.example/acme/widget/pull/3', ghe)).toBe(true);
    for (const bad of [
      'https://evil.example.com/acme/widget/pull/3',
      'http://code.acme.example/acme/widget/pull/3',
      'https://code.acme.example/acme/widget/issues/3',
      'https://code.acme.example/acme/widget/pull/3?x=1',
      'https://user@code.acme.example/acme/widget/pull/3',
    ]) expect(isGithubPullUrl(bad, ghe), bad).toBe(false);
    expect(isWorktaskPrUrl('https://code.acme.example/acme/widget/pull/3', ghe)).toBe(true);
    expect(isWorktaskPrUrl('https://code.acme.example/acme/widget/pull/3')).toBe(false);
  });

  it('a merge request page reads as one (the UI says MR)', () => {
    expect(isMergeRequestUrl('https://gitlab.example.com/group/sub/proj/-/merge_requests/7')).toBe(true);
    expect(isMergeRequestUrl('https://gitlab.example.com:8443/gitlab/group/proj/-/merge_requests/7')).toBe(true);
    expect(isMergeRequestUrl('https://github.com/acme/widget/pull/3')).toBe(false);
    expect(isMergeRequestUrl(undefined)).toBe(false);
  });
});
