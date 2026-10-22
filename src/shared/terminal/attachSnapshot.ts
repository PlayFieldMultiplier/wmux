/**
 * TASK-10: initial-attach flushes at or above this size go through the
 * daemon-side HeadlessSnapshot instead of shipping raw bytes. Below it the
 * renderer parses the raw replay faster than a snapshot round would cost.
 *
 * Shared by the daemon's SessionPipe (which flushes a smaller ring without the
 * snapshot queue, #2585) and the renderer (which keeps a smaller replay that
 * reached a hidden new pane instead of re-requesting it through that queue on
 * reveal). Import-free, so the renderer and main bundles can read it without
 * pulling in SessionPipe and @xterm/headless.
 */
export const ATTACH_SNAPSHOT_MIN_BYTES = 256 * 1024;
