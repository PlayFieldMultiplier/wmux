// Process grouping for the idle-agent memory baseline (scripts/lib/idle-memory.mjs).
//
// The baseline is only comparable across runs if every process lands in the
// same group each time: the daemon is a child of the app and runs the same
// executable, and the measuring script itself runs inside a wmux pane.
import { describe, expect, it } from 'vitest';
import { findAppPid, groupMemory, median, medianOf, parsePsRows, treeRss } from '../lib/idle-memory.mjs';

const APP = '/Applications/wmux.app/Contents/MacOS/wmux';
const HELPERS = '/Applications/wmux.app/Contents/Frameworks';
// rss column is KiB
const PS = [
  `  100     1  1024 ${APP}`,
  `  101   100  2048 ${HELPERS}/wmux Helper (Renderer).app/Contents/MacOS/wmux Helper (Renderer)`,
  `  102   100   512 ${HELPERS}/wmux Helper.app/Contents/MacOS/wmux Helper`,
  `  200   100  4096 ${APP}`, // the daemon: same executable, child of the app
  `  300   200   256 /bin/zsh`, // a pane shell
  `  301   300  8192 claude`,
  `  302   301  1024 node`, // its MCP server
  `  400   200   256 /bin/zsh`, // the pane the script runs in
  `  401   400   128 node`, // the script
  `  402   401    64 ps`,
  `  900     1  9999 /usr/sbin/unrelated`,
].join('\n');

describe('idle-memory grouping', () => {
  const rows = parsePsRows(PS);

  it('finds the app by its renderer child, not the daemon that shares its executable', () => {
    expect(findAppPid(rows)).toBe(100);
  });

  it('groups app, daemon and workloads once each and leaves out the measuring script', () => {
    const g = groupMemory(rows, 100, 200, 401);
    expect(g.appMain.rssBytes).toBe(1024 * 1024);
    expect(g.appRenderer.rssBytes).toBe(2048 * 1024);
    expect(g.appHelpers.rssBytes).toBe(512 * 1024);
    expect(g.app.processes).toBe(3);
    expect(g.daemon.rssBytes).toBe(4096 * 1024);
    // both shells and the agent tree; not the script (401) or its ps (402)
    expect(g.workloads.processes).toBe(4);
    expect(g.workloads.rssBytes).toBe((256 + 8192 + 1024 + 256) * 1024);
  });

  it('measures an agent as its pane shell and everything under it', () => {
    expect(treeRss(rows, 300)).toEqual({ processes: 3, rssBytes: (256 + 8192 + 1024) * 1024 });
  });

  it('takes the median of each counter across samples', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const s = (rss) => ({ groups: { daemon: { processes: 1, rssBytes: rss } }, agents: [{ kind: 'claude', ptyId: 'p', processes: 3, rssBytes: rss }] });
    expect(medianOf([s(10), s(30), s(20)])).toEqual({
      groups: { daemon: { processes: 1, rssBytes: 20 } },
      agents: [{ kind: 'claude', ptyId: 'p', processes: 3, rssBytes: 20 }],
    });
  });
});
