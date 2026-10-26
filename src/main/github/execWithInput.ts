import { execFile } from 'node:child_process';

export interface ExecWithInputOptions {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  maxBuffer?: number;
  /** Written to the process's stdin and closed. */
  input?: string;
}

/**
 * execFile with text of any length (a PR body) as `input` on stdin: on argv
 * it can pass Windows' 32,767-character command line, and the spawn then
 * fails before the tool starts. Rejects as promisify(execFile) does, with
 * `stdout` and `stderr` on the error; a spawn that throws (that very
 * ENAMETOOLONG) rejects too. Without `input`, stdin is left as it was.
 */
export function execWithInput(
  cmd: string,
  args: string[],
  { input, ...opts }: ExecWithInputOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...opts, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
    if (input === undefined) return;
    child.stdin?.on('error', () => { /* the tool exited before reading its input; the exit says why */ });
    child.stdin?.end(input);
  });
}
