import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level wiring invariants for the Linux maker options (icon and runtime deps).
//
// GNOME (dock, taskbar, alt-tab) takes an installed app's icon from the
// `.desktop` file's `Icon=wmux`, which resolves to /usr/share/pixmaps/wmux.png.
// electron-installer-debian / -redhat fill that file from their `icon` option
// and, when it is absent, fall back to their bundled resources/icon.png — the
// stock Electron logo. So a deb/rpm built without `icon` shows the Electron icon
// even though the window itself carries the wmux icon.
//
// forge.config.ts cannot be imported in a unit test (makers are platform-gated
// and pull in native tooling), so the wiring is pinned over its source text —
// the same pattern as makerDebAsarCache.test.ts.

const forgeConfigPath = path.join(__dirname, '..', '..', '..', 'forge.config.ts');
const src = fs.readFileSync(forgeConfigPath, 'utf-8');

function makerOptions(maker: string): string {
  const start = src.indexOf(`new ${maker}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}),', start);
  return src.slice(start, end);
}

describe('Linux makers ship the wmux icon, not the Electron default', () => {
  it.each(['MakerDeb', 'MakerRpm', 'MakerAppImage'])('%s sets icon to assets/icon.png', (maker) => {
    expect(makerOptions(maker)).toMatch(/icon:\s*'\.\/assets\/icon\.png'/);
  });

  it('the icon asset the makers point at exists', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'))).toBe(true);
  });
});

// Electron loads libasound.so.2 at startup. electron-installer-debian lists ALSA
// only under Recommends, which `apt install --no-install-recommends` and minimal
// images skip, and electron-installer-redhat does not list it at all, so a
// package without these entries installs cleanly and then fails to start.
describe('Linux makers require the ALSA library', () => {
  it('MakerDeb depends on libasound2t64 or libasound2', () => {
    expect(makerOptions('MakerDeb')).toMatch(/depends:\s*\[[^\]]*'libasound2t64 \| libasound2'/);
  });

  it('MakerRpm requires alsa-lib or libasound2', () => {
    expect(makerOptions('MakerRpm')).toMatch(/requires:\s*\[[^\]]*'\(alsa-lib or libasound2\)'/);
  });
});
