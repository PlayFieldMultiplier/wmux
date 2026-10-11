import { describe, it, expect } from 'vitest';
import { describeSecretFindings, scanUnifiedDiff, secretFileKind, secretValueKind } from '../secretGuard';

describe('secretFileKind', () => {
  it.each([
    ['.env', 'env'], ['app/.env.local', 'env'], ['certs/server.pem', 'private-key'], ['id_ed25519', 'private-key'],
    ['.git-credentials', 'credentials'], ['home/.aws/config', 'credentials'], ['x/.docker/config.json', 'credentials'], ['vault.kdbx', 'credentials'],
  ] as const)('%s is %s', (p, kind) => expect(secretFileKind(p)).toBe(kind));

  it.each(['.env.example', '.env.sample', 'config/.env.template', 'id_ed25519.pub', '.npmrc', 'src/credentials.ts', 'docker/config.json', 'README.md'])(
    '%s is committable', (p) => expect(secretFileKind(p)).toBeNull());
});

describe('secretValueKind', () => {
  it.each([
    [`OPENAI_API_KEY=sk-proj-${'A1b2'.repeat(8)}`, 'openai'],
    [`const k = "sk-ant-api03-${'x9Y8'.repeat(8)}"`, 'openai'],
    [`token: ghp_${'a1B2'.repeat(9)}`, 'github'],
    ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'aws'],
    ['SLACK=xoxb-123456789012-abcdefghij', 'slack'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key'],
    ['DB_PASSWORD="q8Zr2LpX0vKt9mNw4YcB7sHd"', 'random'],
  ] as const)('%s → %s', (line, kind) => expect(secretValueKind(line)).toBe(kind));

  it.each([
    'const apiKey = process.env.OPENAI_API_KEY;',
    'API_KEY=your_api_key_here_please_change',
    'TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '"integrity": "sha512-abc"',
    `commit ${'0123456789abcdef'.repeat(2)}`,
    'const password = "";',
  ])('%s is not a secret', (line) => expect(secretValueKind(line)).toBeNull());
});

describe('scanUnifiedDiff', () => {
  const diff = [
    'diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+A=1',
    'diff --git a/src/c.ts b/src/c.ts', '--- a/src/c.ts', '+++ b/src/c.ts', '@@ -10,0 +11,2 @@',
    '+const ok = 1;', `+const key = "ghp_${'a1B2'.repeat(9)}";`,
    'diff --git a/old.pem b/old.pem', 'deleted file mode 100644', '--- a/old.pem', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    'diff --git a/k.p12 b/k.p12', 'new file mode 100644', 'Binary files /dev/null and b/k.p12 differ',
  ].join('\n');

  it('finds added secret files (text or binary) and values with their line, never a deleted one', () => {
    expect(scanUnifiedDiff(diff)).toEqual([
      { path: '.env', what: 'file', kind: 'env' },
      { path: 'src/c.ts', what: 'value', kind: 'github', line: 12 },
      { path: 'k.p12', what: 'file', kind: 'private-key' },
    ]);
  });

  it('describes a finding in plain words without the value', () => {
    const text = describeSecretFindings(scanUnifiedDiff(diff), 'pushed');
    expect(text).toContain('.env holds passwords and keys, so it was not pushed');
    expect(text).toContain('(and 2 more)');
    expect(text).not.toContain('ghp_');
  });
});
