// The folder-trust dialog every automated send stops at, whatever the policy:
// recognised from measured screens (fixtures/folder-trust/), and nothing else.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeApprovalPrompt, looksLikeFolderTrustDialog } from '../approvalKeystrokes';
import { CODEX_TRUST_HEADLINE } from '../../../shared/folderTrustWording';

const screen = (dir: string, name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const TRUST_FIXTURES = [
  'claude-folder-trust-120x40',
  'claude-folder-trust-60x30',
  'codex-folder-trust-120x40',
  'codex-folder-trust-60x30',
  // Both choices and the key hint wrap at 22 columns.
  'codex-folder-trust-22x30',
  // Boxed, numbered, no key hint; the cursor is a dot.
  'gemini-folder-trust-120x40',
  'gemini-folder-trust-60x30',
  // Every choice label is cut with an ellipsis at 22 columns.
  'gemini-folder-trust-22x30',
  'qwen-folder-trust-120x40',
  'qwen-folder-trust-60x30',
  'qwen-folder-trust-22x30',
];

describe('looksLikeFolderTrustDialog', () => {
  it.each(TRUST_FIXTURES)('recognises the measured dialog %s', (name) => {
    expect(looksLikeFolderTrustDialog(screen('folder-trust', name))).toBe(true);
  });

  it("catches Claude's unnumbered choices, which the option-row check misses", () => {
    const rows = screen('folder-trust', 'claude-folder-trust-120x40');
    expect(looksLikeApprovalPrompt(rows)).toBe(false);
    expect(looksLikeFolderTrustDialog(rows)).toBe(true);
  });

  it('recognises the older wordings, numbered or not', () => {
    expect(looksLikeFolderTrustDialog([
      'Do you trust the files in this folder?',
      '',
      '❯ 1. Yes, proceed',
      '  2. No, exit',
      '',
      'Enter to confirm · Esc to cancel',
    ])).toBe(true);
    expect(looksLikeFolderTrustDialog([
      'Do you trust the files in this folder?',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
      'Enter to confirm · Esc to cancel',
    ])).toBe(true);
    expect(looksLikeFolderTrustDialog([
      '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk',
      '› 1. Yes, continue',
      '  2. No, quit',
      '  Press enter to continue',
    ])).toBe(true);
    expect(looksLikeFolderTrustDialog([
      'Do you trust the contents of this project?',
      '❯ Yes, I trust this folder',
      'No, exit',
      '↑/↓ Navigate · enter Confirm',
    ])).toBe(true);
  });

  it('still recognises the dialog in a pane narrow enough to wrap its rows', () => {
    // About 30 columns: the question takes three rows, the key hint and the
    // longest choice wrap a word onto a row of their own.
    expect(looksLikeFolderTrustDialog([
      ' Quick safety check: Is this a',
      ' project you created or one you',
      ' trust? (Like your own code, a',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to',
      ' cancel',
    ])).toBe(true);
    expect(looksLikeFolderTrustDialog([
      '  Trust this folder? Codex can',
      '  read, edit, and run files here,',
      '› 1. Trust and continue',
      '  2. Back to Agent Command',
      '  Center',
      '  enter continue · esc back',
    ])).toBe(true);
  });

  it('rejoins a grant choice wrapped at about 26 columns', () => {
    expect(looksLikeFolderTrustDialog([
      ' Quick safety check: Is this',
      ' a project you created or',
      ' one you trust?',
      ' ❯ No, exit',
      '   Yes, I trust this',
      '   folder',
      ' Enter to confirm · Esc to',
      ' cancel',
    ])).toBe(true);
  });

  it('joins a question, a choice and the key hint wrapped at about 14 columns', () => {
    expect(looksLikeFolderTrustDialog([
      ' Quick safety',
      ' check: Is this',
      ' a project you',
      ' created or one',
      ' you trust?',
      ' (Like your own',
      ' ❯ No, exit',
      '   Yes, I trust',
      '   this folder',
      ' Enter to',
      ' confirm · Esc',
      ' to cancel',
    ])).toBe(true);
  });

  it('leaves an ordinary unnumbered menu alone', () => {
    // Claude Code 2.1.283's Bypass Permissions warning: "❯ No, exit" and the
    // same key hint, but no trust question.
    expect(looksLikeFolderTrustDialog(screen('terminal-prompts', 'claude-bypass-warning-menu'))).toBe(false);
    expect(looksLikeFolderTrustDialog([
      ' Choose the text style that looks best with your terminal',
      '     Auto (match terminal)',
      ' ❯ ✔ Dark mode',
      '     Light mode',
    ])).toBe(false);
  });

  it('needs the dialog itself, not the question quoted in prose', () => {
    expect(looksLikeFolderTrustDialog([
      '⏺ When Codex asks "Trust this folder?" pick Trust and continue.',
      '──────────',
      '❯ ',
    ])).toBe(false);
    // A question at a row start with no choices under it.
    expect(looksLikeFolderTrustDialog(['Trust this folder? It is up to you.', '❯ '])).toBe(false);
  });

  it('needs the choice that grants trust among the choices', () => {
    expect(looksLikeFolderTrustDialog([
      'Do you trust the files in this folder?',
      '❯ No, exit',
      '  Quit',
      'Enter to confirm · Esc to cancel',
    ])).toBe(false);
  });

  it('needs exactly one selection cursor on the choices', () => {
    const rows = screen('folder-trust', 'codex-folder-trust-120x40');
    const uncursored = rows.map((row) => row.replace('› 1.', '  1.'));
    expect(looksLikeFolderTrustDialog(uncursored)).toBe(false);
    const twoCursors = rows.map((row) => row.replace('  2.', '› 2.'));
    expect(looksLikeFolderTrustDialog(twoCursors)).toBe(false);
  });

  it("matches Gemini CLI's and Qwen Code's measured questions", () => {
    expect(CODEX_TRUST_HEADLINE.test('Do you trust the files in this folder?')).toBe(true);
    expect(CODEX_TRUST_HEADLINE.test('Do you trust this folder?')).toBe(true);
  });

  it('a lone choice cut with an ellipsis is not a dialog', () => {
    expect(looksLikeFolderTrustDialog(['Do you trust this folder?', '› 1. Trust f…'])).toBe(false);
    expect(looksLikeFolderTrustDialog(['Do you trust this folder?', '● Trust f…'])).toBe(false);
  });

  it('every cut choice must be the start of a known label', () => {
    const question = ['Do you trust this folder?'];
    // Too short to name a label.
    expect(looksLikeFolderTrustDialog([...question, '› 1. Tr…', '  2. Tru…', "  3. Don't trust"])).toBe(false);
    // Not the start of any trust label.
    expect(looksLikeFolderTrustDialog([...question, '› 1. Trust fo…', '  2. Run anyway…'])).toBe(false);
    expect(looksLikeFolderTrustDialog([...question, '› 1. Trust fo…', "  2. Don't tr…"])).toBe(true);
  });

  it('needs a granting choice when every label is cut', () => {
    expect(looksLikeFolderTrustDialog(['Do you trust this folder?', "› 1. Don't tr…", '  2. Quit'])).toBe(false);
  });

  it('a boxed dialog with anything under its bottom edge is not live', () => {
    // Gemini CLI after Enter on "Trust folder": a restart notice and its prompt under the last frame.
    expect(looksLikeFolderTrustDialog(screen('folder-trust', 'gemini-folder-trust-answered-120x40'))).toBe(false);
    const rows = screen('folder-trust', 'qwen-folder-trust-60x30');
    expect(looksLikeFolderTrustDialog([...rows, 'Restarting…'])).toBe(false);
  });

  it('needs exactly one dot cursor on a Gemini CLI dialog', () => {
    const rows = screen('folder-trust', 'gemini-folder-trust-120x40');
    expect(looksLikeFolderTrustDialog(rows.map((row) => row.replace('  2. Trust parent', '● 2. Trust parent')))).toBe(false);
    expect(looksLikeFolderTrustDialog(rows.map((row) => row.replace('● 1.', '  1.')))).toBe(false);
  });

  it('leaves agent output that talks about trusting a folder alone', () => {
    expect(looksLikeFolderTrustDialog([
      'ℹ Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.',
      '>   Type your message or @path/to/file',
    ])).toBe(false);
    // A reply quoting the question, with dot bullets shaped like its choices, and the input box under it.
    expect(looksLikeFolderTrustDialog([
      '✦ When Gemini asks "Do you trust the files in this folder?" pick one of:',
      '● 1. Trust folder (proj)',
      '  2. Trust parent folder (work)',
      "  3. Don't trust",
      '',
      '>   Type your message or @path/to/file',
    ])).toBe(false);
  });

  it('a dialog already answered, with agent output or a shell prompt under it, is not live', () => {
    const rows = screen('folder-trust', 'claude-folder-trust-120x40');
    expect(looksLikeFolderTrustDialog([...rows, '', ' ✻ Welcome to Claude Code!', '', '> '])).toBe(false);
    // "No, exit" picked: Claude's last frame stays above the shell prompt.
    for (const prompt of ['user@host proj %', '$', 'Done']) {
      expect(looksLikeFolderTrustDialog([...rows, prompt])).toBe(false);
    }
  });
});
