// ─── A bot's profile: its skills ────────────────────────────────────────────
//
// The skills the bot wrote for itself (shared/botSkill.ts), through the
// preload bridge `electronAPI.factory.skills` (main-window IPC). Each row says
// where the skill stands — approved (its version), waiting for the owner's
// approval card, approved with an update waiting, archived — and every one
// not archived has Archive. Approving and denying happen on the card, where
// the change is shown; the profile only lists and archives.
import { useCallback, useEffect, useState } from 'react';
import { FOCUS_RING } from '../focusRing';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { getFactoryBotPort } from '../Room/factoryPorts';
import type { BotSkillView, SkillArchiveRequest, SkillArchiveResult, SkillListResult } from '../../../shared/botSkill';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface BotSkillPort {
  readonly available: boolean;
  list(botId: string): Promise<SkillListResult>;
  archive(req: SkillArchiveRequest): Promise<SkillArchiveResult>;
}

const UNAVAILABLE = { ok: false as const, error: 'Skills are not available in this build.' };

function bridgePort(): BotSkillPort {
  const api = (globalThis as { electronAPI?: { factory?: { skills?: Partial<BotSkillPort> } } }).electronAPI;
  const b = api?.factory?.skills;
  return {
    available: !!b?.list && !!b.archive,
    list: (botId) => b?.list?.(botId) ?? Promise.resolve(UNAVAILABLE),
    archive: (req) => b?.archive?.(req) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotSkillPort | null = null;

export function getBotSkillPort(): BotSkillPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotSkillPort(next: BotSkillPort | null): void {
  port = next;
}

/** One bot's skills, re-read on every bot event (main pushes
 *  `skills-changed` there). */
export function useBotSkills(botId: string, p: BotSkillPort = getBotSkillPort()): BotSkillView[] {
  const [skills, setSkills] = useState<BotSkillView[]>([]);
  const reload = useCallback(() => {
    if (!p.available) return;
    p.list(botId).then((r) => {
      if (r?.ok) setSkills(r.skills);
    }, () => undefined);
  }, [p, botId]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return skills;
}

/** Where a skill stands, in the owner's words. Pure. */
export function skillStateText(s: BotSkillView, t: T): string {
  if (s.state === 'archived') return t('botsPage.profile.skillArchived');
  if (s.state === 'proposed') return t('botsPage.profile.skillProposed', { version: s.proposed?.version ?? '' });
  const approved = t('botsPage.profile.skillApproved', { version: s.version ?? '' });
  return s.proposed ? `${approved} · ${t('botsPage.profile.skillUpdateProposed', { version: s.proposed.version })}` : approved;
}

export function BotSkills({ row, t, port: p = getBotSkillPort() }: { row: FactoryBotRow; t: T; port?: BotSkillPort }): React.ReactElement | null {
  const botId = row.bot.id;
  const skills = useBotSkills(botId, p);
  const [error, setError] = useState<string | null>(null);
  if (!p.available) return null;
  const archive = (name: string) => {
    setError(null);
    p.archive({ botId, name }).then((r) => {
      if (!r.ok) setError(r.error);
    }, () => setError(t('botsPage.profile.skillArchiveFailed')));
  };
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-skills>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.skills')}</span>
      <div className="min-w-0 flex-1">
        {skills.length === 0 && <p className="text-[var(--text-muted)]">{t('botsPage.profile.skillsEmpty')}</p>}
        <ul className="space-y-0.5">
          {skills.map((s) => (
            <li key={s.name} data-bot-skill={s.name} data-skill-state={s.state} className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate ${s.state === 'approved' ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`} title={s.description ?? s.proposed?.description}>
                {s.name}
                <span className="text-[var(--text-muted)]">{` · ${skillStateText(s, t)}`}</span>
              </span>
              {s.state !== 'archived' && (
                <button type="button" data-testid={`bot-skill-archive-${s.name}`} onClick={() => archive(s.name)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
                  {t('botsPage.profile.skillArchive')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="mt-1 text-[var(--accent-red)]">{error}</p>}
      </div>
    </div>
  );
}
