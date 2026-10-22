// glabConfigPath: the one config file glab reads, step by step in the order
// of glab's ConfigDir (internal/config/config_file.go), on win32 too.
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { glabConfigPath } from '../forgeHosts';

const home = os.homedir();
const legacy = path.join(home, '.config', 'glab-cli', 'config.yml');
const none = () => false;
const onlyLegacy = (f: string) => f === legacy;

describe('glabConfigPath — glab\'s ConfigDir chain', () => {
  it('1. GLAB_CONFIG_DIR, when set, wins over everything', () => {
    expect(glabConfigPath({ GLAB_CONFIG_DIR: '/g', XDG_CONFIG_HOME: '/x', LOCALAPPDATA: '/local' }, () => true, 'win32')).toBe(path.join('/g', 'config.yml'));
  });

  it('2. the legacy <home>/.config/glab-cli, when its config.yml exists, wins over XDG and the platform dir', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(glabConfigPath({ XDG_CONFIG_HOME: '/x', LOCALAPPDATA: '/local' }, onlyLegacy, platform), platform).toBe(legacy);
    }
  });

  it('3. XDG_CONFIG_HOME/glab-cli, when set, even before its file exists', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(glabConfigPath({ XDG_CONFIG_HOME: '/x', LOCALAPPDATA: '/local' }, none, platform), platform).toBe(path.join('/x', 'glab-cli', 'config.yml'));
    }
  });

  it('4. win32: %LOCALAPPDATA%, else ~/AppData/Local; never the roaming %APPDATA%', () => {
    expect(glabConfigPath({ APPDATA: '/roaming', LOCALAPPDATA: '/local' }, none, 'win32')).toBe(path.join('/local', 'glab-cli', 'config.yml'));
    expect(glabConfigPath({ APPDATA: '/roaming' }, none, 'win32')).toBe(path.join(home, 'AppData', 'Local', 'glab-cli', 'config.yml'));
  });

  it('4. elsewhere: ~/Library/Application Support on macOS, ~/.config on Linux', () => {
    expect(glabConfigPath({ LOCALAPPDATA: '/local' }, none, 'darwin')).toBe(path.join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml'));
    expect(glabConfigPath({ LOCALAPPDATA: '/local' }, none, 'linux')).toBe(legacy);
  });
});
