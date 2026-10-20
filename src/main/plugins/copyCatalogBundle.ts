import * as fs from 'node:fs';
import * as path from 'node:path';

/** Copy only reviewed catalog assets; never discover files from a bundle manifest. */
export function copyCatalogBundle(source: string, destination: string, files: readonly string[]): void {
  if (!files.length || files.length > 64 || new Set(files).size !== files.length
    || !['manifest.json', 'README.md', 'LICENSE'].every((file) => files.includes(file))) {
    throw new Error('Invalid catalog file list');
  }
  const root = fs.lstatSync(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid catalog bundle');
  let total = 0;
  const checked = files.map((file) => {
    if (file.length > 256 || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file)
      || file.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid catalog path');
    const parts = file.split('/');
    let current = source;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error('Invalid catalog bundle');
      }
      if (index === parts.length - 1) total += stat.size;
    }
    if (total > 8 * 1024 * 1024) throw new Error('Catalog bundle exceeds size limit');
    return { source: current, destination: path.join(destination, ...parts) };
  });
  for (const file of checked) {
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.copyFileSync(file.source, file.destination, fs.constants.COPYFILE_EXCL);
  }
}
