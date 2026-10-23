// A replay of how a Rust CLI spawns a hook command on Windows, for tests.
//
// Kiro CLI is closed source. Its open-source predecessor,
// aws/amazon-q-developer-cli (crates/chat-cli/src/cli/chat/cli/hooks.rs), runs a
// hook on Windows as
//
//   tokio::process::Command::new("cmd").arg("/C").arg(command)
//
// so the whole command string is ONE argument, quoted by Rust std. Node's own
// spawn quotes differently, so the exact command line is rebuilt here and handed
// to cmd.exe with windowsVerbatimArguments.

const BACKSLASH = '\\';

/**
 * Rust std's Windows quoting of one regular argument: `append_arg` with
 * `Quote::Auto` in library/std/src/sys/args/windows.rs. The argument is wrapped
 * in quotes only when it holds a space or a tab, or is empty. Every inner `"`
 * becomes `\"`, with the backslashes before it doubled, and the backslashes
 * before a closing quote are doubled too.
 */
export function rustWindowsQuoteArg(arg: string): string {
  const quote = arg === '' || /[ \t]/.test(arg);
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === BACKSLASH) {
      backslashes += 1;
    } else {
      if (ch === '"') out += BACKSLASH.repeat(backslashes + 1);
      backslashes = 0;
    }
    out += ch;
  }
  if (quote) out += BACKSLASH.repeat(backslashes) + '"';
  return out;
}

/**
 * Spawn arguments that give cmd.exe the command line Rust builds for
 * `Command::new("cmd").arg("/C").arg(command)`: `"cmd" /C <quoted command>`.
 * Rust always quotes the program name (`make_command_line`); `argv0` puts
 * that first token on the line verbatim. Pass with `windowsVerbatimArguments`.
 */
export function rustCmdCSpawn(command: string): { args: string[]; argv0: string } {
  return { args: ['/C', rustWindowsQuoteArg(command)], argv0: '"cmd"' };
}
