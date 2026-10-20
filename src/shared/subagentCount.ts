// A pane's subagent count travels daemon → main → renderer as a pushed value.
// While it is not 0 the daemon sends it again every SUBAGENT_COUNT_REFRESH_MS,
// and the renderer stops showing one older than SUBAGENT_COUNT_STALE_MS. A
// count a client missed (a dropped subscription, a reload, a main restart)
// then comes back on the next refresh, and a stale one it kept (a 0 it never
// got) goes away on its own.

export const SUBAGENT_COUNT_REFRESH_MS = 15_000;
export const SUBAGENT_COUNT_STALE_MS = 45_000;
