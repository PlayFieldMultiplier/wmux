// The folder-trust dialog every automated send stops at, whatever the policy:
// recognised from measured screens (fixtures/folder-trust/), and nothing else.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeApprovalPrompt, looksLikeFolderTrustDialog } from '../approvalKeystrokes';

const screen = (dir: string, name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const TRUST_FIXTURES = [
  'claude-folder-trust-120x40',
  'claude-folder-trust-60x30',
  'codex-folder-trust-120x40',
  'codex-folder-trust-60x30',
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
