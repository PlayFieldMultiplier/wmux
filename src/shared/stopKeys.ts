// The two keys that stop what a pane is doing (ctrl+c, escape), as main's
// input.sendKey names them, shared with the CLI so both answer a stop key to
// a terminal that has not started the same way (#2398).

export const STOP_KEYS: ReadonlySet<string> = new Set(['ctrl+c', 'escape']);

/** Whether `key` (as input.sendKey takes it, any case) is a stop key. */
export function isStopKey(key: string): boolean {
  return STOP_KEYS.has(key.toLowerCase());
}

/** The not-running answer to a stop key: nothing runs there, and nothing is started for it. */
export function nothingToStopMessage(method: string): string {
  return `${method}: the pane's terminal is not running — nothing to stop; nothing was written`;
}
