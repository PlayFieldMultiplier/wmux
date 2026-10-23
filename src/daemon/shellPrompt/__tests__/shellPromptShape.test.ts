import { describe, expect, it } from 'vitest';
import { classifyPromptRow, lastNonBlankRow } from '../shellPromptShape';

describe('classifyPromptRow', () => {
  it.each([
    'Push to origin? [y/N] ',
    'Proceed (y/n)?',
    'Overwrite existing file? [Y/n]:',
    'Remove the branch? (yes/no)',
    'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
  ])('a yes/no question: %s', (row) => {
    expect(classifyPromptRow(row)).toEqual({ shape: 'yes-no', question: row.trim() });
  });

  it.each([
    'Press Enter to continue...',
    'press RETURN',
    '[Press ENTER]',
    'Press any key to continue . . .',
  ])('an Enter prompt: %s', (row) => {
    expect(classifyPromptRow(row)).toEqual({ shape: 'enter', question: row.trim() });
  });

  it.each([
    'Password:',
    '[sudo] password for someone: ',
    "Password for 'https://git.example.com': ",
    'Enter passphrase for key \'/k/id_ed25519\':',
    'Enter PIN for token: ',
    'Verification code: ',
  ])('a secret carries its shape only, never its row: %s', (row) => {
    expect(classifyPromptRow(row)).toEqual({ shape: 'secret' });
  });

  it.each([
    // A log line quoting a prompt and going on is no prompt.
    'note: answer (y/N) when asked, then wait',
    'Building… 42%',
    'Press Enter to continue, or wait 10 s for the default',
    'npm WARN deprecated',
    '',
  ])('no prompt: %s', (row) => {
    expect(classifyPromptRow(row)).toBeNull();
  });

  it('caps a long row', () => {
    const row = `${'x'.repeat(400)} [y/N]`;
    expect(classifyPromptRow(row)?.question?.length).toBe(200);
  });
});

describe('lastNonBlankRow', () => {
  it('the bottom-most row with content, without trailing blanks', () => {
    expect(lastNonBlankRow(['$ git push', 'Continue? [y/N]   ', '', '   '])).toBe('Continue? [y/N]');
    expect(lastNonBlankRow(['', '  '])).toBeNull();
  });
});
