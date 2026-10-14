// secret_request / secret_list / login_request — a bot asks the owner for a
// named secret or a login (shared/botSecret.ts), registered with
// registerToolModule (src/mcp/toolModules.ts). The value is typed by the
// owner into a wmux form and never comes back to the bot: secret_list
// answers names only, and a worker started with fanout_start secret_names
// gets the values as env vars.

import { z } from 'zod';
import { BOT_SECRET_LIMITS, BOT_SECRET_RPC } from '../shared/botSecret';
import { registerToolModule } from './toolModules';

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

registerToolModule({
  name: 'factory-secret-tools',
  tools: ['secret_request', 'secret_list', 'login_request'],
  register(host, deps) {
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>) => ({
      ...(await deps.callRpc(method, compact(params))),
    });

    host.tool(
      'secret_request',
      'Ask the owner to enter one secret (an API key or token) in a private wmux form; a card with Enter appears in your room. '
        + 'You never see the value. Name it as its env var, upper case and credential-shaped (NPM_TOKEN, OPENAI_API_KEY, ..._SECRET). '
        + 'Once stored, a worker you start with fanout_start secret_names gets it as that env var. Never ask for a secret in chat.',
      {
        name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
        label: z.string().min(1).max(BOT_SECRET_LIMITS.LABEL_MAX).describe('What it is, e.g. "npm publish token".'),
        why: z.string().min(1).max(BOT_SECRET_LIMITS.WHY_MAX).describe('Why you need it (shown to the owner).'),
      },
      async ({ name, label, why }) => call(BOT_SECRET_RPC.request, { name, label, why }),
    );

    host.tool(
      'secret_list',
      'List the stored secrets: names, which bot\'s worker used each last and when. Never values.',
      {},
      async () => call(BOT_SECRET_RPC.list, {}),
    );

    host.tool(
      'login_request',
      'Ask the owner to log in: github (GitHub CLI sign-in), claude (Claude Code sign-in) or website (opens url, an https login page, for the owner; nothing is filled in for them). A card appears in your room.',
      {
        service: z.enum(['github', 'claude', 'website']),
        url: z.string().url().max(2048).optional().describe('website: the https login page.'),
        why: z.string().min(1).max(BOT_SECRET_LIMITS.WHY_MAX),
      },
      async ({ service, url, why }) => call(BOT_SECRET_RPC.loginRequest, { service, url, why }),
    );
  },
});
