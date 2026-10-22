// The usage-limit card: what a pane held at its provider's limit can do now,
// opened from its limit chip (and by itself once, when the active pane hits
// the limit). A popover, so the terminal never shrinks and nothing covers it
// at rest:
//   - Resume automatically when it reopens (on by default, per pane);
//   - Continue on another account, with 2+ accounts, and the opt-in "Always
//     switch automatically" (the vendor's switch-by-quota setting);
//   - Continue in another agent that is installed and signed in: a new tab
//     with the handoff typed in, not sent (utils/continueInAgent.ts);
//   - when every account is out, the earliest time one reopens.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { updateUsageLimit } from '../../hooks/useUsageLimitBridge';
import { refreshAgentStatus, useAgentSetup } from '../../utils/agentSetupRuns';
import { continueInAgent } from '../../utils/continueInAgent';
import { agentRow } from '../../../shared/agentIdentity';
import { formatResetClock } from '../../../shared/usageLimit';
import { placePopover } from '../AgentToolbar/placePopover';
import { useAccountRotation } from '../Settings/AccountRotationControls';
import Popover, { PopoverSection } from '../ui/Popover';
import Switch from '../ui/Switch';
import Checkbox from '../ui/Checkbox';
import Button from '../ui/Button';
import { usageLimitStatusText, usageLimitView, everyAccountOutUntil } from './usageLimitPresentation';
import type { PaneActionItem } from './PaneActionsMenu';

export const USAGE_LIMIT_CARD_WIDTH = 300;

export default function UsageLimitCard({ ptyId, workspaceId, paneId, cwd, now, accountItems, anchor, triggerRef, onClose }: {
  ptyId: string;
  workspaceId: string;
  paneId: string;
  cwd?: string;
  now: number;
  /** One per account the conversation can move to (usePaneContinueOnAccount). */
  accountItems: PaneActionItem[];
  anchor: { top: number; left: number; right: number; bottom: number };
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const limit = useStore((s) => s.usageLimits[ptyId]);
  const rotation = useAccountRotation();
  const setup = useAgentSetup();
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);

  useEffect(() => { void refreshAgentStatus(); }, []);
  // Measured after each render, so placePopover can flip it above the chip.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    // Capture on keydown: the terminal swallows keys.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  if (!limit) return null;
  const view = usageLimitView(limit, now, getLocale());
  const vendor = limit.provider;
  const fromAgent = agentRow(vendor)?.display ?? vendor;
  const rotationOn = rotation.state?.settings[vendor] === true;
  const outUntil = everyAccountOutUntil(rotation.state?.rows ?? [], vendor, now);
  const agents = (setup.statuses ?? []).filter((s) => s.readiness === 'ready' && s.agent !== vendor);
  const pos = placePopover(anchor, { width: USAGE_LIMIT_CARD_WIDTH, height });

  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={t('usageLimit.cardTitle')}
      data-usage-limit-card={view.phase}
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: USAGE_LIMIT_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <PopoverSection title={t('usageLimit.cardTitle')}>
        <p className="text-[12px] text-[var(--text-sub)] tabular-nums" data-usage-limit-card-status>{usageLimitStatusText(view, t)}</p>
        {outUntil !== undefined && (
          <p className="text-[12px] text-[var(--text-sub)] tabular-nums" data-usage-limit-card-all-out>
            {outUntil === null ? t('usageLimit.allAccountsOutUnknown') : t('usageLimit.allAccountsOut', { clock: formatResetClock(outUntil, now, getLocale()) })}
          </p>
        )}
        {view.canArm && (
          <label className="mt-2 flex items-center gap-2 text-[13px] text-[var(--text-main)]">
            <Switch
              checked={view.armed}
              onCheckedChange={(on) => { void updateUsageLimit(ptyId, { autoResume: on }); }}
              data-usage-limit-card-action="auto-resume"
            />
            {t('usageLimit.resumeAutomatically')}
          </label>
        )}
        {view.canResumeNow && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => { void updateUsageLimit(ptyId, { resumeNow: true }); onClose(); }} data-usage-limit-card-action="resume">
            {t('usageLimit.resume')}
          </Button>
        )}
      </PopoverSection>
      {accountItems.length >= 2 && (
        <PopoverSection title={t('usageLimit.continueOnAccountTitle')} data-testid="usage-limit-card-accounts">
          <div className="flex flex-col gap-1">
            {accountItems.map((item) => (
              <Button
                key={item.key}
                size="sm"
                variant="ghost"
                className="justify-start"
                disabled={item.disabled}
                title={item.title}
                onClick={() => { item.onSelect(); onClose(); }}
                data-usage-limit-card-account={item.key}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
            <Checkbox
              checked={rotationOn}
              onCheckedChange={(on) => { void window.electronAPI?.accountRotation?.set(vendor, on).then(rotation.reload).catch(() => undefined); }}
              data-usage-limit-card-action="always-switch"
            />
            {t('usageLimit.alwaysSwitch')}
          </label>
        </PopoverSection>
      )}
      {agents.length > 0 && (
        <PopoverSection title={t('usageLimit.continueInAgentTitle')} data-testid="usage-limit-card-agents">
          <div className="flex flex-col gap-1">
            {agents.map((s) => {
              const name = agentRow(s.agent)?.display ?? s.agent;
              return (
                <Button
                  key={s.agent}
                  size="sm"
                  variant="ghost"
                  className="justify-start"
                  title={t('usageLimit.continueInAgentHint')}
                  onClick={() => {
                    void continueInAgent({ heldPtyId: ptyId, fromAgent, agent: s.agent, workspaceId, paneId, ...(cwd ? { cwd } : {}) });
                    onClose();
                  }}
                  data-usage-limit-card-agent={s.agent}
                >
                  {t('usageLimit.continueInAgent', { agent: name })}
                </Button>
              );
            })}
          </div>
        </PopoverSection>
      )}
    </Popover>,
    document.body,
  );
}
