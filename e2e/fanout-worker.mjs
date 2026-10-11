// A fan-out worker's report, done the way WORKER_DELIVERY_PREAMBLE asks: a
// completion post in the mission channel, then ledger_update to
// review_requested. Run by the fake claude's worker script inside the task's
// pane, so the MCP server resolves the worker's own identity.
//
// Usage: node fanout-worker.mjs <reportChars> <summaryChars>
import { connectWmuxMcp } from './mcpClient.mjs';

const MISSION_TOPIC_PREFIX = 'wmux:mission:';
const reportChars = Number(process.argv[2] ?? 1500);
const summaryChars = Number(process.argv[3] ?? 2000);

/** `head` padded with plain words to exactly `n` characters. */
function filler(head, n) {
  let s = head;
  while (s.length < n) s += ' lorem ipsum';
  return s.slice(0, n);
}

const mcp = await connectWmuxMcp('wmux-e2e-worker');
try {
  const listed = await mcp.call('channel_list');
  const channels = listed.json?.channels ?? listed.json?.result?.channels ?? [];
  const mission = channels.find((c) => typeof c.topic === 'string' && c.topic.startsWith(MISSION_TOPIC_PREFIX));
  if (!mission) throw new Error(`no mission channel in channel_list: ${listed.text.slice(0, 300)}`);
  const taskId = mission.topic.slice(MISSION_TOPIC_PREFIX.length);
  const post = await mcp.call('channel_post', { channel_id: mission.id, member_id: 'worker', text: filler(`Report ${taskId}: done.`, reportChars) });
  if (post.isError) throw new Error(`channel_post: ${post.text.slice(0, 300)}`);
  // `expected_rev` is 1 right after fan-out; a stale one is refused, so step up.
  let updated = null;
  for (let rev = 1; rev <= 5 && !updated; rev++) {
    const r = await mcp.call('ledger_update', {
      task_id: taskId,
      status: 'review_requested',
      expected_rev: rev,
      summary: filler(`Summary ${taskId}: landed and verified.`, summaryChars),
    });
    if (!r.isError) updated = rev;
  }
  if (!updated) throw new Error('ledger_update refused at every rev 1..5');
  console.log(`e2e worker reported task=${taskId} rev=${updated}`);
} finally {
  await mcp.close();
}
