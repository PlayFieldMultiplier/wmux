import { describe, it, expect } from 'vitest';
import { isClaudeFirstRunScreen, isClaudeFolderTrustScreen, claudeSetupScreen } from '../claudeFirstRun';

describe('isClaudeFirstRunScreen', () => {
  it('recognises the theme picker seen while dogfooding', () => {
    const excerpt = '❯ ✔ Dark mode\nLight mode\nDark mode (colorblind-friendly)\nLight mode (colorblind-friendly)\nDark mode (ANSI colors only)\n1 function greet() {\nSyntax theme: Monokai Extended (ctrl+t to disable)';
    expect(isClaudeFirstRunScreen(excerpt)).toBe(true);
  });

  it('recognises the login method screen', () => {
    expect(isClaudeFirstRunScreen('Select login method:\n❯ 1. Claude account with subscription')).toBe(true);
  });

  it('does not flag an ordinary permission dialog or empty text', () => {
    expect(isClaudeFirstRunScreen('Do you want to allow WebFetch to example.com?\n❯ 1. Yes\n2. No')).toBe(false);
    expect(isClaudeFirstRunScreen('Do you trust the files in this folder?')).toBe(false);
    expect(isClaudeFirstRunScreen('')).toBe(false);
    expect(isClaudeFirstRunScreen(undefined)).toBe(false);
  });
});

describe('folder trust', () => {
  const trust = "Do you trust the files in this folder?\nClaude Code'll be able to read, edit, and execute files here.\nSecurity guide\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel";
  it('recognises the trust prompt seen while dogfooding', () => {
    expect(isClaudeFolderTrustScreen(trust)).toBe(true);
    expect(claudeSetupScreen(trust)).toBe('folder-trust');
  });
  it('routes the theme picker to first-run and a permission dialog to neither', () => {
    expect(claudeSetupScreen('Syntax theme: Monokai Extended')).toBe('first-run');
    expect(claudeSetupScreen('Do you want to allow WebFetch to example.com?\n❯ 1. Yes\n2. No')).toBeNull();
    expect(isClaudeFolderTrustScreen(undefined)).toBe(false);
  });
});
