import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyCatalogBundle } from '../copyCatalogBundle';
import { UI_PLUGIN_CATALOG } from '../../../shared/pluginManagement';

const roots: string[] = [];
it('keeps every shipped catalog inventory aligned with its complete source bundle and packaging', () => {
  const forge = fs.readFileSync(path.resolve('forge.config.ts'), 'utf8');
  function list(directory: string, prefix = ''): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = `${prefix}${entry.name}`;
      return entry.isDirectory() ? list(path.join(directory, entry.name), `${relative}/`) : [relative];
    });
  }
  for (const entry of UI_PLUGIN_CATALOG) {
    expect([...entry.files].sort()).toEqual(list(path.resolve('examples/plugins', entry.id)).sort());
    expect(forge).toContain(`'./examples/plugins/${entry.id}'`);
  }
});
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-catalog-copy-')); roots.push(root);
  const source = path.join(root, 'source'); const destination = path.join(root, 'staging');
  fs.mkdirSync(source); fs.mkdirSync(destination);
  const files = ['manifest.json', 'README.md', 'LICENSE', 'index.html', 'scripts/office.js', 'images/characters.png'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), `fixture:${file}`);
  }
  return { root, source, destination, files };
}
it('copies declared multi-file assets and license without copying undeclared files', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.source, 'private.txt'), 'not shipped');
  copyCatalogBundle(f.source, f.destination, f.files);
  for (const file of f.files) expect(fs.readFileSync(path.join(f.destination, file))).toEqual(fs.readFileSync(path.join(f.source, file)));
  expect(fs.existsSync(path.join(f.destination, 'private.txt'))).toBe(false);
});
it.each(['../outside', '/absolute', 'a/../outside', 'a\\outside', './index.html',
  'CON.txt', 'assets/NUL.png', 'lpt9.js', 'COM1', 'index.html.', 'assets./page.js', 'index.html '])('rejects unsupported catalog path %s before copying', (file) => {
  const f = fixture(); expect(() => copyCatalogBundle(f.source, f.destination, [...f.files, file])).toThrow('path');
  expect(fs.readdirSync(f.destination)).toEqual([]);
});
it('rejects missing attribution, duplicate entries and oversized bundles', () => {
  const f = fixture();
  expect(() => copyCatalogBundle(f.source, f.destination, f.files.filter((file) => file !== 'LICENSE'))).toThrow('file list');
  expect(() => copyCatalogBundle(f.source, f.destination, [...f.files, 'LICENSE'])).toThrow('file list');
  expect(() => copyCatalogBundle(f.source, f.destination, [...f.files, 'license'])).toThrow('file list');
  fs.truncateSync(path.join(f.source, 'images/characters.png'), 8 * 1024 * 1024);
  expect(() => copyCatalogBundle(f.source, f.destination, f.files)).toThrow('size limit');
  expect(fs.readdirSync(f.destination)).toEqual([]);
});
it('rejects a symlinked asset directory before copying', () => {
  const f = fixture(); const outside = path.join(f.root, 'outside');
  fs.renameSync(path.join(f.source, 'images'), outside);
  fs.symlinkSync(outside, path.join(f.source, 'images'), 'junction');
  expect(() => copyCatalogBundle(f.source, f.destination, f.files)).toThrow('bundle');
  expect(fs.readdirSync(f.destination)).toEqual([]);
});
