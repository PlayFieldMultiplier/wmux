import { describe, expect, it } from 'vitest';
import { classifyPromptRow, lastLineOfOutput, lastNonBlankRow } from '../shellPromptShape';

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
    'Enter PIN:',
    'PIN: ',
    'OTP code: ',
    'Enter your OTP:',
  ])('a secret carries its shape only, never its row: %s', (row) => {
    expect(classifyPromptRow(row)).toEqual({ shape: 'secret' });
  });

  it.each([
    // A log line quoting a prompt and going on is no prompt.
    'note: answer (y/N) when asked, then wait',
    'Building… 42%',
    'Press Enter to continue, or wait 10 s for the default',
    'npm WARN deprecated',
    // PIN and OTP only as a whole prompt row, not anywhere a log line names them.
    'debug: pin: resolved 3 deps:',
    'warning: could not resolve pin:',
    'loaded otp:',
    'otp module loaded: ok:',
    'pin the version in package.json:',
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

describe('lastLineOfOutput', () => {
  it('the last line raw output leaves showing, with escapes, overwrites and backspaces applied', () => {
    expect(lastLineOfOutput('build ok\r\n\x1b[1;33mContinue? [y/N]\x1b[0m ')).toBe('Continue? [y/N]');
    expect(lastLineOfOutput('Downloading 10%\rDownloading 99%\rProceed (y/n)?')).toBe('Proceed (y/n)?');
    expect(lastLineOfOutput('Passwq\x08ord:')).toBe('Password:');
    expect(lastLineOfOutput('\x1b]0;title\x07Password: ')).toBe('Password:');
  });

  it('skips a trailing newline to the line before it, and is null with nothing to show', () => {
    expect(lastLineOfOutput('Press Enter to continue...\r\n')).toBe('Press Enter to continue...');
    expect(lastLineOfOutput('\x1b[2J\x1b[H')).toBeNull();
  });
});
