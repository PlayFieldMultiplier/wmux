// ─── The Bots profile's Engine line ───────────────────────────────────────
//
// What the bot runs on: Claude (SDK) or Hermes, picked here and saved with
// main's engine verb (botsHermes.ts). Switching to Hermes first shows whether
// Hermes can run on this computer, then asks once; switching back to Claude
// saves at once. While the bot is on Hermes the line keeps that readiness
// under the picker, with the one step that fixes it. Any other engine (an
// ACP command, Claude in a terminal) shows read-only.

import { useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button';
import Select from '../ui/Select';
import { FOCUS_RING } from '../focusRing';
import { useStore } from '../../stores';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { isHermesEngine, type BotEngine } from '../../../shared/bot';
import { HERMES_INSTALL_URL, type HermesReadiness } from '../../../shared/hermesEngine';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { InlineConfirm } from './InlineConfirm';
import { bridgeHermesPort, hermesReadinessView, useHermesReadiness, type HermesPort, type PickableEngine } from './botsHermes';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The picker's value for a stored engine, or null when it is not one the
 *  picker offers. Pure. */
export function pickableEngine(engine: BotEngine): PickableEngine | null {
  if (engine.kind === 'claude-sdk') return 'claude-sdk';
  return isHermesEngine(engine) ? 'hermes' : null;
}

function engineName(engine: BotEngine, t: T): string {
  if (engine.kind === 'claude-sdk') return t('botsPage.engine.claudeSdk');
  if (isHermesEngine(engine)) return t('botsPage.engine.hermes');
  if (engine.kind === 'claude-pty') return t('botsPage.engine.claudePty');
  return t('botsPage.engine.acp', { command: [engine.command, ...engine.args].join(' ') });
}

function openHermesPage(): void {
  void window.electronAPI?.shell?.openExternal?.(HERMES_INSTALL_URL)?.catch?.(() => undefined);
}

/** Whether Hermes can run here, in the line's words, with its one fix. */
function HermesReadinessRow({ readiness, checking, recheck, port, t }: {
  readiness: HermesReadiness | null;
  checking: boolean;
  recheck: () => void;
  port: HermesPort;
  t: T;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!readiness) {
    return <p data-bots-hermes-readiness="checking" className="mt-1 text-[11px] text-[var(--text-muted)]">{t('botsPage.hermes.checking')}</p>;
  }
  const view = hermesReadinessView(readiness);
  // Without the setup verb the owner can still ask again after setting up.
  const fix = view.fix === 'setup' && !port.setup ? 'recheck' : view.fix;
  const setUp = async () => {
    if (!port.setup) return;
    setBusy(true);
    try {
      await port.setup();
      // The setup runs in a terminal tab the page steps aside to (as the
      // Claude sign-in does).
      const st = useStore.getState();
      st.pushToast({ message: t('botsPage.hermes.setupOpened'), level: 'info' });
      showWorkspaces(st);
    } catch (err) {
      useStore.getState().pushToast({ message: err instanceof Error ? err.message : String(err), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!view.command) return;
    void navigator.clipboard?.writeText(view.command).then(() => setCopied(true), () => undefined);
  };
  return (
    <div data-bots-hermes-readiness={readiness.ready ? 'ready' : readiness.reason} role="status" className="mt-1 flex flex-col gap-1 text-[11px] leading-snug">
      <p className={readiness.ready ? 'text-[var(--text-muted)]' : 'text-[var(--text-sub)]'}>{t(view.key, view.vars)}</p>
      {readiness.ready && <p data-bots-hermes-can-do className="text-[var(--text-muted)]">{t('botsPage.hermes.canDo')}</p>}
      {view.command && (
        <div className="flex min-w-0 items-center gap-2">
          <code data-bots-hermes-command className="min-w-0 truncate rounded-[6px] bg-[var(--selection-subtle)] px-1.5 py-0.5 font-mono text-[var(--text-sub)]">{view.command}</code>
          <button
            type="button"
            data-bots-hermes-copy
            onClick={copy}
            onBlur={() => setCopied(false)}
            className={`shrink-0 text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
          >
            {copied ? t('botsPage.chat.copied') : t('botsPage.chat.copyCode')}
          </button>
        </div>
      )}
      {fix && (
        <div className="flex items-center gap-1.5">
          {fix === 'install' && <Button size="sm" variant="secondary" data-bots-hermes-install onClick={openHermesPage}>{t('botsPage.hermes.install')}</Button>}
          {fix === 'setup' && <Button size="sm" variant="secondary" data-bots-hermes-setup disabled={busy} onClick={() => void setUp()}>{t('botsPage.hermes.setup')}</Button>}
          {fix === 'recheck' && <Button size="sm" variant="ghost" data-bots-hermes-recheck disabled={checking} onClick={recheck}>{t('botsPage.onboarding.checkAgain')}</Button>}
        </div>
      )}
      {view.detail && (
        <>
          <button
            type="button"
            data-bots-hermes-details
            className="self-start text-[var(--text-muted)] underline-offset-2 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t('botsPage.engineError.hideDetails') : t('botsPage.engineError.showDetails')}
          </button>
          {open && (
            <pre data-bots-hermes-detail className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--selection-subtle)] px-2 py-1 text-[var(--text-muted)]">
              {view.detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** The bot's engine. `port`: the Hermes verbs (default: the preload's). */
export function BotEngineLine({ row, t, port: given }: { row: FactoryBotRow; t: T; port?: HermesPort }) {
  const port = useMemo(() => given ?? bridgeHermesPort(), [given]);
  const current = pickableEngine(row.bot.engine);
  const [staged, setStaged] = useState(false);
  const [pending, setPending] = useState<PickableEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A save in flight shows its value until the profile catches up.
  useEffect(() => { if (pending !== null && pending === current) setPending(null); }, [pending, current]);
  useEffect(() => { if (current === 'hermes') setStaged(false); }, [current]);
  const onHermes = current === 'hermes' || pending === 'hermes' || staged;
  const { readiness, checking, recheck } = useHermesReadiness(port.readiness, onHermes);
  const label = t('botsPage.engine.label');
  const setEngine = port.setEngine;

  const save = async (value: PickableEngine) => {
    if (!setEngine) return;
    setStaged(false);
    setPending(value);
    setError(null);
    try {
      const r = await setEngine(row.bot.id, value);
      if (!r.ok) {
        setPending(null);
        setError(r.message || t('botsPage.engine.saveFailed'));
      }
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const pick = (value: string) => {
    setError(null);
    if (value === 'hermes' && current !== 'hermes') setStaged(true);
    else if (value === 'claude-sdk' && current !== 'claude-sdk') void save('claude-sdk');
    else setStaged(false);
  };

  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-engine>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1">
        {current === null || !setEngine ? (
          <span data-testid="bots-profile-engine-value" className="text-[var(--text-main)]">{engineName(row.bot.engine, t)}</span>
        ) : (
          <Select
            data-testid="bots-profile-engine"
            aria-label={label}
            value={staged ? 'hermes' : pending ?? current}
            disabled={pending !== null}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="claude-sdk">{t('botsPage.engine.claudeSdk')}</option>
            <option value="hermes">{t('botsPage.engine.hermes')}</option>
          </Select>
        )}
        {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
        {onHermes && port.readiness && <HermesReadinessRow readiness={readiness} checking={checking} recheck={recheck} port={port} t={t} />}
        {staged && (
          <div className="mt-1.5">
            <InlineConfirm
              text={t('botsPage.engine.switchConfirm', { name: row.bot.name })}
              confirmLabel={t('botsPage.engine.switch')}
              cancelLabel={t('settings.factory.cancel')}
              busy={false}
              tone="primary"
              testId="bots-profile-engine-switch"
              onConfirm={() => void save('hermes')}
              onCancel={() => setStaged(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
