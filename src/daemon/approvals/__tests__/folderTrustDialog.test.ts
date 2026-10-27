// The folder-trust dialog every automated send stops at, whatever the policy:
// recognised from measured screens (fixtures/folder-trust/), and nothing else.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeApprovalPrompt, looksLikeFolderTrustDialog, readFolderTrustScreen } from '../approvalKeystrokes';

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
  // Whole viewports: the box is the last thing drawn, blank rows under it.
  'gemini-folder-trust-full-120x40',
  'qwen-folder-trust-full-120x40',
  // Gemini CLI's notice under the box after one Ctrl+C, on two rows at 22 columns.
  'gemini-folder-trust-ctrlc-120x40',
  'gemini-folder-trust-ctrlc-22x60',
  // "Don't trust (esc)" cut inside its suffix: "(…", "(e…", "(es…".
  'qwen-folder-trust-27x50',
  'qwen-folder-trust-28x50',
  'qwen-folder-trust-29x50',
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

  it('reads a declining choice cut inside its "(esc)" suffix', () => {
    const question = ['Do you trust this folder?'];
    for (const decline of ["  3. Don't trust (…", "  3. Don't trust (e…", "  3. Don't trust (es…"]) {
      expect(looksLikeFolderTrustDialog([...question, '› 1. Trust folder (q…', '  2. Trust parent fo…', decline])).toBe(true);
    }
    // Past the suffix it is no label any more.
    expect(looksLikeFolderTrustDialog([...question, '› 1. Trust folder (q…', "  3. Don't trust (esx…"])).toBe(false);
  });

  it('at 18 columns the choices are too short to read: not a dialog, but not clear either', () => {
    for (const name of ['gemini-folder-trust-18x60', 'qwen-folder-trust-18x60', 'gemini-folder-trust-ctrlc-18x60']) {
      const rows = screen('folder-trust', name);
      expect(looksLikeFolderTrustDialog(rows)).toBe(false);
      expect(readFolderTrustScreen(rows)).toBe('unreadable');
    }
    // One short row, rows with no trust question, or rows that name no label are not that shape.
    expect(readFolderTrustScreen(['Do you trust this folder?', '› 1. Trus…'])).toBeNull();
    expect(readFolderTrustScreen(['Pick one', '› 1. Trus…', '  2. Trus…'])).toBeNull();
    expect(readFolderTrustScreen(['Do you trust this folder?', '› 1. Run…', '  2. Skip…'])).toBeNull();
    for (const name of TRUST_FIXTURES) expect(readFolderTrustScreen(screen('folder-trust', name))).toBe('trust');
  });

  it('a folder name is any bracketed text to the end of the row', () => {
    expect(looksLikeFolderTrustDialog([
      'Do you trust this folder?',
      '› 1. Trust folder (a (b (c)))',
      '  2. Trust parent folder (work)',
      "  3. Don't trust (esc)",
    ])).toBe(true);
  });

  it('a whole choice takes only a row indented under its label', () => {
    // Codex 0.162.1 at 22 columns: "Back to Agent" goes on under its label.
    expect(looksLikeFolderTrustDialog(screen('folder-trust', 'codex-folder-trust-22x30'))).toBe(true);
    // Answered: a shell prompt under the last choice is no part of it.
    const choices = ['  Trust this folder? Codex can read,', '› 1. Trust and continue', '  2. Back to Agent Command Center'];
    expect(looksLikeFolderTrustDialog(choices)).toBe(true);
    expect(looksLikeFolderTrustDialog([...choices, 'user host'])).toBe(false);
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
    expect(looksLikeFolderTrustDialog([...rows, 'Press Ctrl+C again to exit.', '> '])).toBe(false);
  });

  it('reads the dot cursor moved to any choice of a Gemini CLI dialog, and needs exactly one', () => {
    for (const name of ['gemini-folder-trust-120x40', 'gemini-folder-trust-22x30']) {
      const rows = screen('folder-trust', name);
      const unselected = rows.map((row) => row.replace('● 1.', '  1.'));
      expect(looksLikeFolderTrustDialog(unselected)).toBe(false);
      for (const digit of ['2', '3']) {
        expect(looksLikeFolderTrustDialog(unselected.map((row) => row.replace(`  ${digit}. `, `● ${digit}. `)))).toBe(true);
        expect(looksLikeFolderTrustDialog(rows.map((row) => row.replace(`  ${digit}. `, `● ${digit}. `)))).toBe(false);
      }
    }
  });

  it('a dot is a cursor only inside a box round the question and its choices', () => {
    // A reply quoting the question, its dot bullets the last rows on screen.
    expect(looksLikeFolderTrustDialog([
      '✦ When Gemini asks "Do you trust the files in this folder?" pick one of:',
      '● 1. Trust folder (proj)',
      '  2. Trust parent folder (work)',
      "  3. Don't trust",
    ])).toBe(false);
    // The same rows boxed, as Gemini CLI draws its dialog.
    expect(looksLikeFolderTrustDialog([
      ' │ Do you trust the files in this folder? │',
      ' │ ● 1. Trust folder (proj)               │',
      ' │   2. Trust parent folder (work)        │',
      " │   3. Don't trust                       │",
      ' ╰────────────────────────────────────────╯',
    ])).toBe(true);
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
