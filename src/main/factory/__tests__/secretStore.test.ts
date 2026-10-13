// The bot secret store, its redaction and its single-use worker grants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: {} }));

import { SecretStore, type SecretCrypto, type SecretCryptoState } from '../secretStore';
import {
  __resetRedactedSecretsForTesting,
  redactStoredSecrets,
  redactStoredSecretsDeep,
  secretForms,
  setRedactedSecrets,
} from '../secretRedaction';
import {
  __resetSecretGrantsForTesting,
  mintSecretGrant,
  parseSecretNames,
  resolveSecretGrant,
  secretEnvForCreate,
  secretNamesRefusal,
  setSecretGrantSource,
} from '../secretGrants';
import { isBotSecretName } from '../../../shared/botSecret';
import { beginBotWorkerSpawn, botWorkerForCreate } from '../../agents/botWorkerMergeGuard';

const VALUE = 'npm_AbCdEf0123456789xyz';

/** A reversible stand-in for safeStorage: never the plaintext on disk. */
function fakeCrypto(state: SecretCryptoState = 'ok'): SecretCrypto & { setState(s: SecretCryptoState): void } {
  let current = state;
  return {
    setState(s) { current = s; },
    state: () => current,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').reverse().toString('hex')}`),
    decrypt: (cipher) => {
      const text = cipher.toString();
      if (!text.startsWith('enc:')) throw new Error('bad cipher');
      return Buffer.from(text.slice(4), 'hex').reverse().toString('utf8');
    },
  };
}

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w4-secrets-'));
  file = path.join(dir, 'factory', 'secrets.json');
  __resetRedactedSecretsForTesting();
  __resetSecretGrantsForTesting();
});

afterEach(() => {
  setSecretGrantSource(null);
  __resetRedactedSecretsForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('secret names', () => {
  it('takes credential-shaped upper-case env names only', () => {
    for (const ok of ['NPM_TOKEN', 'OPENAI_API_KEY', 'DEPLOY_SECRET', 'DB_PASSWORD']) expect(isBotSecretName(ok)).toBe(true);
    // Not credential-shaped, not upper snake case, or reserved.
    for (const bad of ['PATH', 'HOME', 'NODE_OPTIONS', 'npm_token', 'MY_NAME', 'WMUX_AUTH_TOKEN', 'X', '', 42]) {
      expect(isBotSecretName(bad)).toBe(false);
    }
  });

  it('a fan-out names 1..16 distinct valid names', () => {
    expect(parseSecretNames(['NPM_TOKEN'])).toEqual(['NPM_TOKEN']);
    expect(parseSecretNames([])).toBeNull();
    expect(parseSecretNames(['NPM_TOKEN', 'NPM_TOKEN'])).toBeNull();
    expect(parseSecretNames(['PATH'])).toBeNull();
    expect(parseSecretNames(Array.from({ length: 17 }, (_, i) => `K${i}_TOKEN`))).toBeNull();
    expect(parseSecretNames('NPM_TOKEN')).toBeNull();
  });
});

describe('SecretStore', () => {
  it('writes safeStorage ciphertext to a 0600 file and never the value', () => {
    const store = new SecretStore({ file, crypto: fakeCrypto() });
    store.load();
    const r = store.set('NPM_TOKEN', VALUE, { label: 'npm publish token', requestedBy: 'bot-0000abcd' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(VALUE);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.secrets[0]).toMatchObject({ name: 'NPM_TOKEN', label: 'npm publish token', requestedBy: 'bot-0000abcd' });
    expect(typeof parsed.secrets[0].cipher).toBe('string');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.list())).not.toContain(VALUE);
  });

  it('decrypts on load and serves values only to main', () => {
    const crypto = fakeCrypto();
    new SecretStore({ file, crypto }).load();
    const a = new SecretStore({ file, crypto });
    a.load();
    a.set('NPM_TOKEN', VALUE);
    const b = new SecretStore({ file, crypto });
    b.load();
    expect(b.has('NPM_TOKEN')).toBe(true);
    expect(b.values(['NPM_TOKEN'])).toEqual({ ok: true, env: { NPM_TOKEN: VALUE } });
    expect(b.values(['NPM_TOKEN', 'GH_TOKEN'])).toEqual({ ok: false, missing: ['GH_TOKEN'] });
  });

  it('refuses to store when encryption is unavailable or the Linux backend is basic_text', () => {
    const crypto = fakeCrypto('basic_text');
    const store = new SecretStore({ file, crypto });
    store.load();
    const r = store.set('NPM_TOKEN', VALUE);
    expect(r).toMatchObject({ ok: false, code: 'basic_text' });
    expect(fs.existsSync(file)).toBe(false);
    crypto.setState('unavailable');
    expect(store.set('NPM_TOKEN', VALUE)).toMatchObject({ ok: false, code: 'encryption_unavailable' });
    expect(fs.existsSync(file)).toBe(false);
    expect(store.has('NPM_TOKEN')).toBe(false);
  });

  it('refuses a non-credential name and a value out of bounds', () => {
    const store = new SecretStore({ file, crypto: fakeCrypto() });
    store.load();
    expect(store.set('MY_NAME', VALUE)).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(store.set('PATH', VALUE)).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(store.set('NPM_TOKEN', 'short')).toMatchObject({ ok: false, code: 'invalid_value' });
    expect(store.set('NPM_TOKEN', 42)).toMatchObject({ ok: false, code: 'invalid_value' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses before load and records use; delete removes the value (still redacted: see below)', () => {
    const store = new SecretStore({ file, crypto: fakeCrypto(), now: () => 1000 });
    expect(store.set('NPM_TOKEN', VALUE)).toMatchObject({ ok: false, code: 'not_loaded' });
    store.load();
    store.set('NPM_TOKEN', VALUE);
    store.markUsed(['NPM_TOKEN'], 'bot-0000abcd');
    expect(store.list()[0].lastUsed).toEqual({ botId: 'bot-0000abcd', at: 1000 });
    expect(redactStoredSecrets(`x ${VALUE} y`)).toBe('x [secret:NPM_TOKEN] y');
    expect(store.delete('NPM_TOKEN')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.has('NPM_TOKEN')).toBe(false);
  });

  it('keeps redacting a replaced or deleted value (workers started before still hold it)', () => {
    const store = new SecretStore({ file, crypto: fakeCrypto() });
    store.load();
    store.set('NPM_TOKEN', VALUE);
    store.set('NPM_TOKEN', 'npm_SecondValue987654321');
    expect(redactStoredSecrets(`${VALUE} npm_SecondValue987654321`)).toBe('[secret:NPM_TOKEN] [secret:NPM_TOKEN]');
    store.delete('NPM_TOKEN');
    expect(redactStoredSecrets(`${VALUE} npm_SecondValue987654321`)).toBe('[secret:NPM_TOKEN] [secret:NPM_TOKEN]');
  });

  it('never keeps a label that holds the value, and refuses a value that is not well-formed text', () => {
    const store = new SecretStore({ file, crypto: fakeCrypto() });
    store.load();
    const r = store.set('NPM_TOKEN', VALUE, { label: `key ${VALUE}` });
    expect(r.ok && r.entry.label).toBeFalsy();
    expect(fs.readFileSync(file, 'utf8')).not.toContain(VALUE);
    expect(store.set('GH_TOKEN', `abcdefgh\ud800xyz`)).toMatchObject({ ok: false, code: 'invalid_value' });
  });

  it('an unreadable or other-version file is never written over', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of ['{not json', JSON.stringify({ version: 2, secrets: [] })]) {
      fs.writeFileSync(file, content);
      const store = new SecretStore({ file, crypto: fakeCrypto(), log: () => undefined });
      store.load();
      expect(store.set('NPM_TOKEN', VALUE)).toMatchObject({ ok: false, code: 'store_unreadable' });
      expect(store.storeRefusal()).toMatchObject({ code: 'store_unreadable' });
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('keeps an undecryptable entry listed but unusable', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, secrets: [{ name: 'NPM_TOKEN', cipher: Buffer.from('garbage').toString('base64'), createdAt: 1, updatedAt: 1 }] }));
    const store = new SecretStore({ file, crypto: fakeCrypto(), log: () => undefined });
    store.load();
    expect(store.list().map((e) => e.name)).toEqual(['NPM_TOKEN']);
    expect(store.has('NPM_TOKEN')).toBe(false);
  });
});

describe('redaction', () => {
  beforeEach(() => setRedactedSecrets([{ name: 'NPM_TOKEN', value: VALUE }]));

  it('replaces the value and its common encodings', () => {
    for (const form of secretForms(VALUE)) {
      expect(redactStoredSecrets(`before ${form} after`)).toBe('before [secret:NPM_TOKEN] after');
    }
    expect(secretForms(VALUE)).toContain(Buffer.from(VALUE).toString('base64'));
    expect(secretForms(VALUE)).toContain(Buffer.from(VALUE).toString('hex'));
  });

  it('replaces a value a terminal wrapped across lines', () => {
    const wrapped = `$ echo $NPM_TOKEN\r\n${VALUE.slice(0, 7)}\r\n${VALUE.slice(7)}\r\n$ `;
    const out = redactStoredSecrets(wrapped);
    expect(out).not.toContain(VALUE.slice(7));
    expect(out).toContain('[secret:NPM_TOKEN]');
    expect(out.startsWith('$ echo $NPM_TOKEN')).toBe(true);
  });

  it('walks nested results and keeps the reference when nothing matches', () => {
    const clean = { a: ['x', { b: 'y' }] };
    expect(redactStoredSecretsDeep(clean)).toBe(clean);
    const dirty = { screen: { text: `ok ${VALUE}` }, lines: [VALUE], n: 3 };
    expect(JSON.stringify(redactStoredSecretsDeep(dirty))).not.toContain(VALUE);
    expect(redactStoredSecretsDeep(dirty).n).toBe(3);
  });

  it('redacts object keys too', () => {
    const out = redactStoredSecretsDeep({ [VALUE]: true, nested: { [`x${VALUE}`]: 1 } });
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it('is the identity with nothing stored', () => {
    setRedactedSecrets([]);
    expect(redactStoredSecrets(VALUE)).toBe(VALUE);
  });
});

describe('secret grants', () => {
  const worktree = path.join(os.tmpdir(), 'wtask-x');
  let store: SecretStore;
  beforeEach(() => {
    store = new SecretStore({ file, crypto: fakeCrypto() });
    store.load();
    store.set('NPM_TOKEN', VALUE);
    setSecretGrantSource(() => store);
  });

  const me = { botId: 'bot-0000abcd', taskId: 'wtask-t-10000000' };
  const mint = () => mintSecretGrant({ ...me, ownerWorkspaceId: 'ws-1', cwd: worktree, names: ['NPM_TOKEN'] });
  const spawn = { strictBotWorker: true, fanoutTaskOf: 'ws-1', cwd: worktree, spawns: [me] };

  it('resolves once, for the bot worker launch it was minted for, and records the use', () => {
    const id = mint();
    expect(id).toMatch(/^sg-/);
    expect(resolveSecretGrant(id, spawn)).toEqual({ ok: true, env: { NPM_TOKEN: VALUE }, botId: 'bot-0000abcd', names: ['NPM_TOKEN'] });
    expect(resolveSecretGrant(id, spawn)).toMatchObject({ ok: false });
    expect(store.list()[0].lastUsed?.botId).toBe('bot-0000abcd');
  });

  it('refuses another workspace, folder, bot or task, a non-bot create, and is consumed by the failed look', () => {
    for (const wrong of [
      { ...spawn, fanoutTaskOf: 'ws-2' },
      { ...spawn, cwd: path.join(os.tmpdir(), 'elsewhere') },
      { ...spawn, strictBotWorker: false },
      { ...spawn, spawns: [{ ...me, botId: 'bot-0000ffff' }] },
      { ...spawn, spawns: [{ ...me, taskId: 'wtask-t-20000000' }] },
      { ...spawn, spawns: [] },
      { strictBotWorker: true, fanoutTaskOf: 'ws-1', cwd: worktree },
    ]) {
      const id = mint();
      expect(resolveSecretGrant(id, wrong).ok).toBe(false);
      expect(resolveSecretGrant(id, spawn).ok).toBe(false);
    }
    expect(resolveSecretGrant('sg-notminted0123456789', spawn).ok).toBe(false);
    expect(resolveSecretGrant(42, spawn).ok).toBe(false);
  });

  it('expires', () => {
    let now = 1_000;
    __resetSecretGrantsForTesting(() => now);
    const id = mint();
    now += 5 * 60_000;
    expect(resolveSecretGrant(id, spawn)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired|unknown/) });
  });

  it('is not minted for a name that is not stored, and a fan-out naming one is refused', () => {
    expect(mintSecretGrant({ ...me, ownerWorkspaceId: 'ws-1', cwd: worktree, names: ['GH_TOKEN'] })).toBeNull();
    expect(mintSecretGrant({ ...me, taskId: '', ownerWorkspaceId: 'ws-1', cwd: worktree, names: ['NPM_TOKEN'] })).toBeNull();
    expect(secretNamesRefusal(['GH_TOKEN'])).toMatch(/not stored: GH_TOKEN/);
    expect(secretNamesRefusal(['NPM_TOKEN'])).toBeNull();
    setSecretGrantSource(null);
    expect(secretNamesRefusal(['NPM_TOKEN'])).toMatch(/not running/);
  });

  it('the in-flight spawn mark carries main\'s bot and task for the fan-out launch only, until released', () => {
    const release = beginBotWorkerSpawn('ws-1', worktree, me);
    const create = { workspaceId: 'ws-task', cwd: worktree, fanoutTaskOf: 'ws-1' };
    expect(botWorkerForCreate(create, { isBotTaskWorkspace: () => false })).toEqual({ workspaceId: 'ws-task', strict: true, spawns: [me] });
    const id = mint();
    expect(secretEnvForCreate({ ...create, secretGrant: id }, botWorkerForCreate(create, { isBotTaskWorkspace: () => false }))).toEqual({ NPM_TOKEN: VALUE });
    release();
    expect(botWorkerForCreate(create, { isBotTaskWorkspace: () => false, dir })).toBeNull();
  });

  it('pty:create stage: no grant, no secrets; a bad grant fails the create', () => {
    expect(secretEnvForCreate({ cwd: worktree }, null)).toBeUndefined();
    expect(() => secretEnvForCreate({ secretGrant: 'sg-notminted0123456789', fanoutTaskOf: 'ws-1', cwd: worktree }, { strict: true })).toThrow(/PTY_CREATE/);
    const id = mint();
    expect(() => secretEnvForCreate({ secretGrant: id, fanoutTaskOf: 'ws-1', cwd: worktree }, null)).toThrow(/bot worker/);
    const ok = mint();
    expect(() => secretEnvForCreate({ secretGrant: mint(), fanoutTaskOf: 'ws-1', cwd: worktree }, { strict: true })).toThrow(/another bot or task/);
    expect(secretEnvForCreate({ secretGrant: ok, fanoutTaskOf: 'ws-1', cwd: worktree }, { strict: true, spawns: [me] })).toEqual({ NPM_TOKEN: VALUE });
  });
});
