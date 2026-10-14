// worker_resume — a bot relaunches the stopped worker of an ended task it
// started (shared/bot.ts BOT_RPC.resumeWorker); worker_message — a bot
// writes to the live worker of an open task it started
// (BOT_RPC.workerMessage). Registered with registerToolModule
// (src/mcp/toolModules.ts). The bot's token names the bot.

import { z } from 'zod';
import { BOT_RPC, BOT_WORKER_MESSAGE_LIMITS } from '../shared/bot';
import { registerToolModule } from './toolModules';

/** The relaunch, then up to a minute for the agent before the message. */
const RESUME_TIMEOUT_MS = 90_000;
/** The gated delivery waits up to two minutes while someone types. */
const MESSAGE_TIMEOUT_MS = 150_000;

registerToolModule({
  name: 'bot-workers',
  tools: ['worker_resume', 'worker_message'],
  register(host, deps) {
    host.tool(
      'worker_resume',
      'Resume the stopped worker of a task you started that has ended: the same conversation in the same worktree, in a new pane when its pane was closed. '
        + 'Give it the message it should act on. The task stays ended in the ledger; read the result in the worker\'s pane. '
        + 'Refused when every agent slot is in use.',
      {
        task_id: z.string().regex(/^wtask-[A-Za-z0-9_-]{1,80}$/).describe('The ended task (wtask-…).'),
        message: z.string().min(1).max(4000).optional().describe('What the resumed worker should do next.'),
      },
      async ({ task_id, message }) => ({
        ...(await deps.callRpc(BOT_RPC.resumeWorker, { taskId: task_id, ...(message ? { message } : {}) }, RESUME_TIMEOUT_MS)),
      }),
    );

    host.tool(
      'worker_message',
      'Write to the live worker of an open task you started (working, or waiting for input): answer its question, '
        + 'unblock it, or steer it. The text is typed into its prompt once nobody is typing there. '
        + '"delivered" means it reached the worker; anything else means it did not. Refused when the worker is not running '
        + '(an ended task: worker_resume) and when you write to one worker too often.',
      {
        task_id: z.string().regex(/^wtask-[A-Za-z0-9_-]{1,80}$/).describe('The open task (wtask-…).'),
        text: z.string().min(1).max(BOT_WORKER_MESSAGE_LIMITS.TEXT_MAX).describe('What the worker should read.'),
      },
      async ({ task_id, text }) => ({
        ...(await deps.callRpc(BOT_RPC.workerMessage, { taskId: task_id, text }, MESSAGE_TIMEOUT_MS)),
      }),
    );
  },
});
