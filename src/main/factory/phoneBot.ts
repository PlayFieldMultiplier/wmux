// ─── The bot the phone talks to ─────────────────────────────────────────────
//
// `/api/moa/messages` from the phone addresses one bot: the one pinned in
// Settings › Bots (factory settings `phoneBotId`), while it exists and is
// enabled; else the oldest enabled Coordinator-template bot; else the oldest
// enabled bot in the HQ workspace's room. None of these: no phone bot (the
// phone is told `no-hq-bot`). Pure.

import { isCoordinatorBot, type BotProfile } from '../../shared/bot';

export function phoneBot(
  bots: readonly BotProfile[],
  settings: { phoneBotId?: string; hqWorkspaceId: string | null },
): BotProfile | null {
  const enabled = bots.filter((b) => b.enabled);
  const oldest = (xs: BotProfile[]): BotProfile | null => [...xs].sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
  if (settings.phoneBotId) {
    const pinned = enabled.find((b) => b.id === settings.phoneBotId);
    if (pinned) return pinned;
  }
  const coordinator = oldest(enabled.filter((b) => isCoordinatorBot(b)));
  if (coordinator) return coordinator;
  return settings.hqWorkspaceId ? oldest(enabled.filter((b) => b.workspaceId === settings.hqWorkspaceId)) : null;
}
