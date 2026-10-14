// ─── Settings: the owner's "Always allow" rules ────────────────────────────
//
// The acts the owner let bots do without asking again (Always allow on an
// approval card), one row each with Revoke. A rule merges only what the
// merge lane would (a verifier's PASS with gate evidence, a trusted author,
// nothing started from outside text), whether or not lane auto-merge is on,
// within the lane's daily cap; the copy says what each rule does. Read and revoked through main (BOT_APPROVAL_IPC).
import { useCallback, useEffect, useState } from 'react';
import type { ElectronAPI } from '../../../preload/preload';
import type { ApprovalRule } from '../../../shared/botApproval';
import Button from '../ui/Button';
import { SettingNote, SettingsSection } from './SettingsLayout';
import { actionKey, approvalsApi, type ApprovalsApi } from '../Room/approvalsStore';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function ApprovalRules({ t, botName, workspaceName, api }: {
  t: T;
  botName: (botId: string) => string | null;
  workspaceName: (workspaceId: string) => string;
  /** Tests: the approvals bridge. */
  api?: ApprovalsApi | null;
}): React.ReactElement | null {
  const bridge = api === undefined ? approvalsApi() : api;
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const r = await bridge.rules();
      if (r.ok) setRules(r.rules);
    } catch {
      /* the list keeps what it last read */
    }
  }, [bridge]);
  useEffect(() => {
    void load();
    const factory = (globalThis as { electronAPI?: Partial<ElectronAPI> }).electronAPI?.factory;
    return factory?.onBotEvent ? factory.onBotEvent(() => void load()) : undefined;
  }, [load]);
  if (!bridge) return null;
  const revoke = async (ruleId: string) => {
    setError(null);
    try {
      const r = await bridge.revokeRule(ruleId);
      if (!r.ok) setError(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  };
  return (
    <SettingsSection id="factoryrules" title={t('settings.factory.rules')} description={t('settings.factory.rulesDesc')} data-testid="factory-approval-rules">
      {rules.length === 0 ? (
        <SettingNote>{t('settings.factory.rulesNone')}</SettingNote>
      ) : (
        <div className="flex flex-col">
          {rules.map((r) => (
            <div key={r.ruleId} data-approval-rule={r.ruleId} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--text-main)]">{t(actionKey(r.action))} · <span className="font-mono text-[12px]">{r.repoKey}</span></span>
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  {'botId' in r.scope
                    ? t('settings.factory.ruleByBot', { name: botName(r.scope.botId) ?? r.scope.botId })
                    : t('settings.factory.ruleByWorkspace', { workspace: workspaceName(r.scope.workspaceId) })}
                </span>
              </span>
              <Button size="sm" variant="destructive" data-testid="approval-rule-revoke" onClick={() => void revoke(r.ruleId)}>{t('settings.factory.ruleRevoke')}</Button>
            </div>
          ))}
        </div>
      )}
      {error && <SettingNote tone="danger" role="alert">{error}</SettingNote>}
    </SettingsSection>
  );
}
