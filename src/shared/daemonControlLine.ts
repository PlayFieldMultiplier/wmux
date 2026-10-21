/**
 * Longest line main's DaemonClient keeps on the daemon control pipe, in
 * characters of the decoded string (DaemonClient MAX_LINE_BUFFER). A reply
 * line past it is dropped without an error and its request times out, so a
 * daemon reply that can grow with data (the batched `task.mission.list`,
 * shared/missionListBatch.ts) sizes itself against this.
 */
export const DAEMON_CONTROL_LINE_MAX_CHARS = 1024 * 1024;
