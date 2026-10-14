// Characterization of SurfacesStore.save (merge with what is on disk now,
// replay of this instance's changes, every refusal) and editJsonKeys (every
// path shape, unsafe keys, arrays, formatting kept). Each scenario compares the
// WHOLE outcome with a recorded golden file in ./fixtures/store-json, as text
// so key order is pinned too: the file written (or that none was), the error,
// the warnings and what the store holds afterwards.
//
// Re-record only on purpose: WMUX_RECORD_STORE_JSON=1 npx vitest run <this file>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SurfaceProfile } from '../../../../shared/tokenUsage/profileTypes';
import { editJsonKeys, type JsonEdit } from '../jsonEdit';
import { SurfacesStore } from '../surfacesStore';

const RECORD = process.env.WMUX_RECORD_STORE_JSON === '1';
const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'store-json');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-store-char-'));
  file = path.join(dir, 'surfaces.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function golden(name: string, actual: unknown): void {
  const p = path.join(GOLDEN_DIR, `${name}.json`);
  // JSON.parse messages differ between Node versions; only that parsing failed is pinned.
  const text = (JSON.stringify(actual, null, 2) + '\n')
    .replace(/(Corrupt surfaces store file|corrupt surfaces store file on disk): (?!content is not a JSON object)[^"]*/g, '$1: <parse error>')
    .replace(/Invalid JSON: [^"]*/g, 'Invalid JSON: <parse error>');
  if (RECORD) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(p, text);
    return;
  }
  expect(text).toBe(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
}

const profile = (id: string, name: string, extra: Partial<SurfaceProfile> = {}): SurfaceProfile => ({
  id,
  name,
  createdAt: 1_700_000_000_000,
  providers: { claude: { knownItemIds: ['a', 'b'], disabledItemIds: ['b'] } },
  ...extra,
});

const PROVIDERS = ['claude', 'codex', 'agy', 'other'];

/** What the store holds: intents (via reconcile + getIntent), removed hooks, profiles, warnings. */
function memory(store: SurfacesStore) {
  const intents: Record<string, Record<string, boolean | undefined>> = {};
  const hooks: Record<string, unknown> = {};
  for (const p of PROVIDERS) {
    const ids = store.reconcile(p, []).removedItems;
    if (ids.length) intents[p] = Object.fromEntries(ids.map((id) => [id, store.getIntent(p, id)]));
    const list = store.removedHooks.list(p);
    if (list.length) hooks[p] = list;
  }
  return { intents, hooks, profiles: store.profiles.list(), warnings: [...store.warnings] };
}

function writeDisk(content: unknown): void {
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Runs `act` on a loaded store, then save; records the outcome. */
function saveOutcome(store: SurfacesStore, options?: { replaceCorrupt?: boolean }) {
  let error: string | null = null;
  try {
    store.save(options);
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    error,
    file: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null,
    memory: memory(store),
  };
}

function loaded(content?: unknown, deps?: ConstructorParameters<typeof SurfacesStore>[1]): SurfacesStore {
  if (content !== undefined) writeDisk(content);
  const store = new SurfacesStore(file, deps);
  store.load();
  return store;
}

const someChanges = (store: SurfacesStore) => {
  store.recordIntent('claude', 'x', false);
  store.recordIntent('codex', 'y', true);
  store.removedHooks.add('claude', { id: 'h1', definition: { event: 'Stop' }, originPath: '/p' });
  store.profiles.add(profile('p1', '  Focus  '));
};

describe('SurfacesStore.save characterization', () => {
  it('writes a new file from this instance alone', () => {
    const store = loaded();
    someChanges(store);
    store.removedHooks.add('claude', { id: 'h2', definition: { event: 'Stop', n: 2 } });
    store.removedHooks.add('claude', { id: 'h1', definition: { event: 'Stop', replaced: true } });
    store.removedHooks.take('claude', 'h2');
    store.removedHooks.take('codex', 'none');
    store.profiles.add(profile('p2', 'Second'));
    store.profiles.delete('p2');
    store.profiles.delete('missing');
    golden('store-new-file', saveOutcome(store));
    const noChanges = loaded();
    fs.rmSync(file);
    golden('store-new-file-empty', saveOutcome(noChanges));
  });

  it('merges with what another process wrote since load', () => {
    const store = loaded({ version: 1, intents: { claude: { old: true } }, removedHooks: {}, keepMe: { a: 1 } });
    someChanges(store);
    store.removedHooks.take('claude', 'gone');
    writeDisk({
      zFirst: 'unknown keys come first in the file',
      version: 1,
      intents: { claude: { other: false }, codex: 'not an object', agy: { k: true } },
      removedHooks: { claude: [{ id: 'h1', definition: { event: 'Old' } }, { id: 'gone', definition: {} }], codex: 'not a list' },
      profiles: [profile('p0', '  Disk profile '), { id: 'bad' }, profile('p1', 'focus')],
      later: [1, 2],
    });
    golden('store-merge-disk', saveOutcome(store));
  });

  it('keeps or leaves out the profiles key the way it always has', () => {
    const noKey = loaded({ version: 1, intents: {} });
    noKey.recordIntent('claude', 'a', true);
    const emptyKept = loaded({ version: 1, profiles: [] });
    emptyKept.recordIntent('claude', 'a', true);
    const notArray = loaded({ version: 1, profiles: 'nope' });
    notArray.recordIntent('claude', 'a', true);
    writeDisk({ version: 1, intents: {} });
    const r1 = saveOutcome(noKey);
    writeDisk({ version: 1, profiles: [] });
    const r2 = saveOutcome(emptyKept);
    writeDisk({ version: 1, profiles: 'nope' });
    const r3 = saveOutcome(notArray);
    const setAll = loaded({ version: 1, profiles: [profile('a', 'A')] });
    setAll.profiles.set([profile('b', 'B'), profile('c', 'C')]);
    const r4 = saveOutcome(setAll);
    golden('store-profiles-key', { noKey: r1, emptyKept: r2, notArray: r3, setAll: r4 });
  });

  it('refuses to save over a file it cannot trust, unless told to replace a corrupt one', () => {
    const outcomes: Record<string, unknown> = {};
    for (const [name, disk] of [
      ['invalidJson', '{ not json'],
      ['array', '[1, 2]'],
      ['nullJson', 'null'],
    ] as const) {
      const store = loaded({ version: 1, intents: { claude: { kept: true } } });
      someChanges(store);
      writeDisk(disk);
      outcomes[name] = saveOutcome(store);
      outcomes[`${name}Replace`] = saveOutcome(store, { replaceCorrupt: true });
    }
    for (const [name, disk] of [
      ['newerOnDisk', { version: 2 }],
      ['stringVersion', { version: '1' }],
      ['noVersion', { intents: {} }],
    ] as const) {
      const store = loaded({ version: 1 });
      store.recordIntent('claude', 'a', true);
      writeDisk(disk);
      const first = saveOutcome(store);
      writeDisk({ version: 1 });
      outcomes[name] = { first, again: saveOutcome(store) };
    }
    const refusedAtLoad = loaded({ version: 3, intents: {} });
    refusedAtLoad.recordIntent('claude', 'a', true);
    outcomes.refusedAtLoad = saveOutcome(refusedAtLoad);
    let reads = 0;
    const unreadable = loaded({ version: 1 }, {
      readFile: (p, enc) => {
        reads += 1;
        if (reads > 1) throw new Error('EACCES: permission denied');
        return fs.readFileSync(p, enc);
      },
    });
    unreadable.recordIntent('claude', 'a', true);
    outcomes.unreadable = saveOutcome(unreadable);
    golden('store-refusals', outcomes);
  });

  it('replays profile changes against the file and refuses conflicts there', () => {
    const nameTaken = loaded({ version: 1, profiles: [] });
    nameTaken.profiles.add(profile('mine', 'Shared name'));
    writeDisk({ version: 1, profiles: [profile('theirs', ' shared NAME ')] });
    const r1 = saveOutcome(nameTaken);

    const full = loaded({ version: 1, profiles: [] });
    full.profiles.add(profile('new', 'One more'));
    writeDisk({ version: 1, profiles: Array.from({ length: 50 }, (_, i) => profile(`d${i}`, `Disk ${i}`)) });
    const r2 = saveOutcome(full);

    const rename = loaded({ version: 1, profiles: [profile('same', 'Old')] });
    rename.profiles.add(profile('same', 'New name'));
    const r3 = saveOutcome(rename);

    const tooMany = loaded({ version: 1, profiles: Array.from({ length: 52 }, (_, i) => profile(`x${i}`, `X ${i}`)) });
    const r4 = saveOutcome(tooMany);
    golden('store-profile-replay', { nameTaken: r1, full: r2, rename: r3, tooManyOnDisk: r4 });
  });

  it('reports what load found in the file', () => {
    const out: Record<string, unknown> = {};
    for (const [name, disk] of [
      ['corrupt', '{'],
      ['notObject', '"text"'],
      ['newer', { version: 9 }],
      ['profilesNotArray', { version: 1, profiles: {} }],
      ['badProfiles', { version: 1, profiles: [profile('ok', ' Trim me '), { id: '' }, profile('long', 'x'.repeat(41)), profile('bad-provider', 'P', { providers: { gpt: { knownItemIds: [], disabledItemIds: [] } } as never })] }],
      ['tooMany', { version: 1, profiles: Array.from({ length: 51 }, (_, i) => profile(`m${i}`, `M ${i}`)) }],
      ['intentsAndHooks', { version: 1, intents: { claude: { a: true } }, removedHooks: { claude: [{ id: 'h' , definition: {} }] }, extra: 1 }],
    ] as const) {
      out[name] = memory(loaded(disk));
    }
    golden('store-load', out);
  });
});

describe('editJsonKeys characterization', () => {
  const run = (text: string, edits: JsonEdit[]) => {
    try {
      return { text: editJsonKeys(text, edits) };
    } catch (e) {
      return { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  };
  const base = '{\n  "a": 1,\n  "b": { "c": [1, 2, 3] },\n  "z": true\n}\n';

  it('applies every path shape and keeps the file format', () => {
    golden('json-edits', {
      setTop: run(base, [{ path: ['a'], op: 'set', value: 2 }]),
      setNewNested: run(base, [{ path: ['n', 'm', 0], op: 'set', value: 'x' }, { path: ['n', 'arr', 0, 'k'], op: 'set', value: 1 }]),
      setThroughScalar: run(base, [{ path: ['a', 'deep'], op: 'set', value: 1 }]),
      setThroughNull: run('{"a": null}', [{ path: ['a', 'b'], op: 'set', value: 1 }]),
      deleteTop: run(base, [{ path: ['z'], op: 'delete' }]),
      deleteNested: run(base, [{ path: ['b', 'c'], op: 'delete' }]),
      deleteArrayItem: run(base, [{ path: ['b', 'c', 1], op: 'delete' }]),
      deleteArrayItemByStringKey: run(base, [{ path: ['b', 'c', '1'], op: 'delete' }]),
      deleteMissingParent: run(base, [{ path: ['q', 'r'], op: 'delete' }]),
      deleteThroughScalar: run(base, [{ path: ['a', 'r'], op: 'delete' }]),
      deleteThroughNull: run('{"a": null, "k": 1}', [{ path: ['a', 'r'], op: 'delete' }, { path: ['k'], op: 'delete' }]),
      replaceRoot: run(base, [{ path: [], op: 'set', value: { only: true } }]),
      clearRoot: run(base, [{ path: [], op: 'delete' }]),
      noEdits: run('{"a":1}', []),
      noChange: run('{"a":  1}', [{ path: ['a'], op: 'set', value: 1 }]),
      deleteAbsent: run('{"a":  1}', [{ path: ['b'], op: 'delete' }]),
      unsafeKeys: run(base, [
        { path: ['__proto__', 'x'], op: 'set', value: 1 },
        { path: ['b', 'constructor'], op: 'set', value: 1 },
        { path: ['prototype'], op: 'set', value: 1 },
        { path: ['a'], op: 'set', value: 'kept' },
      ]),
      invalidJson: run('{ "a": ', [{ path: ['a'], op: 'set', value: 1 }]),
      invalidJsonNoEdits: run('', []),
    });
  });

  it('keeps tabs, four spaces, CRLF and a missing final newline', () => {
    golden('json-format', {
      tabs: run('{\n\t"a": 1\n}\n', [{ path: ['b'], op: 'set', value: [1] }]),
      four: run('{\n    "a": 1\n}', [{ path: ['b'], op: 'set', value: { c: 1 } }]),
      crlf: run('{\r\n  "a": 1\r\n}\r\n', [{ path: ['a'], op: 'set', value: 2 }]),
      oneLine: run('{"a":1}', [{ path: ['a'], op: 'set', value: 2 }]),
      threeSpaces: run('{\n   "a": 1\n}\n', [{ path: ['a'], op: 'set', value: 2 }]),
      scalarRoot: run('5', [{ path: ['a'], op: 'set', value: 1 }]),
      arrayRoot: run('[1, 2]', [{ path: [0], op: 'delete' }]),
    });
  });
});
