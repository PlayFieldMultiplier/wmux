import { describe, it, expect } from 'vitest';
import { describeSecretFindings, parseNameStatusZ, scanPatch, secretFileKind, secretValueKind } from '../secretGuard';
import { redactSecrets } from '../redactSecrets';

describe('secretFileKind (a file the change adds)', () => {
  it.each([
    ['.env', 'env'], ['app/.env.local', 'env'], ['.env.production.local', 'env'], ['id_ed25519', 'private-key'],
    ['keys/release.keystore', 'private-key'], ['upload.jks', 'private-key'], ['cert.p12', 'private-key'],
    ['.git-credentials', 'credentials'], ['home/.aws/credentials', 'credentials'], ['vault.kdbx', 'credentials'],
    ['home/.ssh/id_work', 'private-key'],
  ] as const)('%s is %s', (p, kind) => expect(secretFileKind(p)).toBe(kind));

  it.each([
    '.env.example', '.env.sample', 'config/.env.template', 'id_ed25519.pub', '.npmrc', 'src/credentials.ts', 'docker/config.json', 'README.md',
    // Judged by content, not name:
    'ios/CredentialsView.swift', 'android/CredentialsManager.kt', 'Pitch.key', 'i18n/messages.key', 'KEYS.asc', 'apt-key.gpg',
    'android/app/debug.keystore', 'certs/cert.pem', 'certs/fullchain.pem', 'credentials.example.json', 'credentials.json',
    '.env.development', '.env.production', 'home/.aws/config', 'home/.ssh/known_hosts', 'x/.docker/config.json',
  ])('%s is not refused by its name', (p) => expect(secretFileKind(p)).toBeNull());
});

describe('secretValueKind', () => {
  it.each([
    [`OPENAI_API_KEY=sk-proj-${'A1b2'.repeat(8)}`, 'openai'],
    [`const k = "sk-ant-api03-${'x9Y8'.repeat(8)}"`, 'anthropic'],
    [`stripe: sk_live_${'4eC3'.repeat(6)}`, 'stripe'],
    [`rk_live_${'4eC3'.repeat(6)}`, 'stripe'],
    ['SLACK_APP=xapp-1-A0123456789-0123456789-abcdef', 'slack'],
    [`//registry.npmjs.org/:_authToken=npm_${'a1B2'.repeat(9)}`, 'npm'],
    [`GITLAB=glpat-${'x1Y2'.repeat(5)}`, 'gitlab'],
    [`TWILIO=SK${'0123456789abcdef'.repeat(2)}`, 'twilio'],
    [`token: ghp_${'a1B2'.repeat(9)}`, 'github'],
    ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'aws'],
    ['SLACK=xoxb-123456789012-abcdefghij', 'slack'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'private-key'],
    ['DB_PASSWORD="q8Zr2LpX0vKt9mNw4YcB7sHd"', 'random'],
    ['apiKey: "Zq8r2LpX0vKt9mNw4YcB7sHd"', 'random'],
    // Every assignment on a line is read, not only the first.
    ['{ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa4", password: "q8Zr2LpX0vKt9mNw4YcB7sHd" }', 'random'],
  ] as const)('%s → %s', (line, kind) => expect(secretValueKind(line)).toBe(kind));

  it.each([
    'const apiKey = process.env.OPENAI_API_KEY;',
    'API_KEY=your_api_key_here_please_change',
    'TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '"integrity": "sha512-abc"',
    `commit ${'0123456789abcdef'.repeat(2)}`,
    'const password = "";',
    // Identifiers, storage keys, module ids and paths that sit after a key-ish name.
    "const STORAGE_KEY = 'wmux.channelMentionHandled.v1';",
    "{ key: 'hiddenFloodFrameDeltaP95Ms_N4' }",
    "{ key: 'github.com/openwong2kim/wmux' }",
    '{ key: "dashboard.widgets.layout.v3" }',
    'tokenizer: "cl100k_base_tokenizer_v2"',
    // Public by design.
    '<key>API_KEY</key><string>AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q</string>',
    'const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.Zq8r2LpX0vKt9mNw4YcB7sHd";',
    "vapid: { publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa40HIqIr8vJ6Mn9B5D4QhVbPp7tL2kXo3mZq8r' }",
  ])('%s is not a secret', (line) => expect(secretValueKind(line)).toBeNull());
});

const add = (p: string, lines: string[]) =>
  [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];

it('reads a long key-like line in linear time', () => {
  const line = `${'key='.repeat(20_000)}.`;
  const t = Date.now();
  expect(secretValueKind(line)).toBeNull();
  expect(Date.now() - t).toBeLessThan(500);
});

describe('scanPatch', () => {
  it('finds added secret files and values with their line; a deleted or modified secret-named file is not refused by name', () => {
    const files = parseNameStatusZ('A\0.env\0M\0src/c.ts\0A\0k.p12\0M\0.env.local\0');
    const patch = [
      ...add('.env', ['A=1']),
      'diff --git a/src/c.ts b/src/c.ts', '--- a/src/c.ts', '+++ b/src/c.ts', '@@ -10,0 +11,2 @@',
      '+const ok = 1;', `+const key = "ghp_${'a1B2'.repeat(9)}";`,
      'diff --git a/k.p12 b/k.p12', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/k.p12', '@@ -0,0 +1 @@', '+\x00\x01',
      'diff --git a/.env.local b/.env.local', '--- a/.env.local', '+++ b/.env.local', '@@ -1 +1 @@', '-A=1', '+A=2',
    ].join('\n');
    expect(scanPatch(files, patch)).toEqual([
      { path: '.env', what: 'file', kind: 'env' },
      { path: 'src/c.ts', what: 'value', kind: 'github', line: 12 },
      { path: 'k.p12', what: 'file', kind: 'private-key' },
    ]);
  });

  it('takes paths from the name list: content that looks like a header never becomes a path', () => {
    const key = `ghp_${'a1B2'.repeat(9)}`;
    const files = parseNameStatusZ('A\0notes.md\0');
    const patch = ['diff --git a/notes.md b/notes.md', 'new file mode 100644', '--- /dev/null', '+++ b/notes.md', '@@ -0,0 +1,2 @@', `+++ ${key}`, `+--- b/${key}`].join('\n');
    const found = scanPatch(files, patch) ?? [];
    expect(found).toEqual([{ path: 'notes.md', what: 'value', kind: 'github', line: 1 }]);
    expect(describeSecretFindings(found, 'pushed')).not.toContain(key);
  });

  it('reads both halves of a type change and reports nothing when the patch does not line up with the names', () => {
    const files = parseNameStatusZ('\x01abc\0\nT\0l\0');
    const patch = [
      '\x01abc', '', 'diff --git a/l b/l', 'deleted file mode 120000', '--- a/l', '+++ /dev/null', '@@ -1 +0,0 @@', '-a.txt', '\\ No newline at end of file',
      ...add('l', ['AKIAIOSFODNN7EXAMPLE']),
    ].join('\n');
    expect(scanPatch(files, patch)).toEqual([{ path: 'l', what: 'value', kind: 'aws', line: 1 }]);
    expect(scanPatch(parseNameStatusZ('A\0a\0A\0b\0'), add('a', ['x']).join('\n'))).toBeNull();
  });

  it('reads env and credential files for assigned secrets, skipping public and placeholder values', () => {
    const files = parseNameStatusZ('A\0.env.production\0A\0credentials.json\0');
    const patch = [
      ...add('.env.production', ['NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9', 'API_URL=https://x.example', 'SECRET_KEY=changeme', 'DB_PASSWORD=hunter2hunter2']),
      ...add('credentials.json', ['{', '  "client_id": "123.apps.googleusercontent.com",', '  "auth": "", "client_secret": "GOCSPX-abcdefgh12345"', '}']),
    ].join('\n');
    expect(scanPatch(files, patch)).toEqual([
      { path: '.env.production', what: 'value', kind: 'env', line: 4 },
      { path: 'credentials.json', what: 'value', kind: 'credentials', line: 3 },
    ]);
  });

  it('describes a finding in plain words without the value', () => {
    const text = describeSecretFindings([{ path: '.env', what: 'file', kind: 'env' }, { path: 'a.ts', what: 'value', kind: 'github', line: 2 }], 'pushed');
    expect(text).toBe('.env holds passwords and keys, so it was not pushed. Remove it from the change (or add it to .gitignore) and try again. (and 1 more)');
  });
});

describe('a key shape that is refused is also masked in logs', () => {
  it.each([
    `sk-ant-api03-${'x9Y8'.repeat(8)}`, `sk-proj-${'A1b2'.repeat(8)}`, `sk_live_${'4eC3'.repeat(6)}`,
    `rk_live_${'4eC3'.repeat(6)}`, 'xapp-1-A0123456789-0123456789-abcdef', `npm_${'a1B2'.repeat(9)}`, `glpat-${'x1Y2'.repeat(5)}`,
    `SK${'0123456789abcdef'.repeat(2)}`, `ghp_${'a1B2'.repeat(9)}`, 'AKIAIOSFODNN7EXAMPLE', 'xoxb-123456789012-abcdefghij',
  ])('%s', (key) => {
    expect(secretValueKind(`x ${key} y`)).not.toBeNull();
    expect(redactSecrets(`x ${key} y`)).not.toContain(key);
  });
});
