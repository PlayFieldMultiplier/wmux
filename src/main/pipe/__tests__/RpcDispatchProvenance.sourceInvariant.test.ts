// Dispatch markers are main-process capabilities. Pin each positive production
// writer so a future transport or nested call cannot widen a trust boundary
// without an explicit security-review test change.

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_DIR = path.resolve(__dirname, '..', '..');

function collectProductionTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionTsFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

/**
 * Whether the source could spell `marker` as a key. Escapes count: a `\u` or
 * `\x` can spell any letter, a backslash before another character stands for
 * that character, and a backslash before a line break drops both.
 */
function maySpell(text: string, marker: string): boolean {
  if (/\\[ux]/.test(text)) return true;
  return text.replace(/\\(?:\r\n|[\n\r\u2028\u2029])?/g, '').includes(marker);
}

describe('RPC dispatch provenance source invariant', () => {
  it('a file that spells the marker only through escapes is still read', () => {
    expect(maySpell("{ 'operat\\or': true }", 'operator')).toBe(true);
    expect(maySpell("{ 'oper\\\nator': true }", 'operator')).toBe(true);
    expect(maySpell('{ extern\\u0061lWire: true }', 'externalWire')).toBe(true);
    expect(maySpell("{ 'operand': true }", 'operator')).toBe(false);
  });

  function markerWriters(marker: string): string[] {
    const writers: string[] = [];

    for (const file of collectProductionTsFiles(MAIN_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      // A file that never spells the marker cannot write it: only the few
      // that do are parsed. Parsing every file of main for each marker ran
      // past the test timeout on a loaded Windows runner (#2434).
      if (!maySpell(text, marker)) continue;
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        // Record every object-literal write, not just a literal `true`. A
        // transport must not evade this boundary with `true as const`, a
        // shorthand, ternary, or computed boolean.
        const writesMarker =
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === marker;
        const forwardsMarker =
          ts.isShorthandPropertyAssignment(node) && node.name.text === marker;
        if (writesMarker || forwardsMarker) {
          writers.push(path.relative(MAIN_DIR, file).replaceAll('\\', '/'));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    return writers.sort();
  }

  it('keeps externalWire writes inside PipeServer and the router context constructor', () => {
    expect(markerWriters('externalWire')).toEqual([
      'pipe/PipeServer.ts',
      'pipe/RpcRouter.ts',
    ]);
  });

  it('keeps operator writes inside the renderer bridge and router context constructor', () => {
    expect(markerWriters('operator')).toEqual([
      // The renderer IPC bridge.
      'index.ts',
      // The phone browser bridge. It reaches the router only through
      // PhoneBrowser, which names a fixed set of `browser.*` methods and
      // pins every call to a surface the desktop already owns, so this is a
      // second operator caller in the same file rather than a new transport.
      'index.ts',
      'pipe/RpcRouter.ts',
    ]);
  });
});
