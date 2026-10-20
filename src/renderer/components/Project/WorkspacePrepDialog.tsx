// "New workspace setup" — the project setting that makes a new worktree ready
// to run: which git-ignored config files it gets from this checkout, the
// setup command, and (advanced) the per-task port range and whether bot and
// fan-out workspaces get the files too.
//
// Saving writes the project's wmux.json and IS the trust approval of the
// written bytes (main: project/workspacePrepSettings.ts). A file holding
// commands or a layout the user has not approved is reviewed in the trust
// dialog first; this dialog then offers Review instead of Save.
//
// Built from ui/ like ProjectConfigDialog: grouped rows, one primary.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { workspaceProbeCwd, probeProjectConfig } from '../../utils/projectConfigProbe';
import {
  isDefaultCopyCandidate,
  type WorkspacePrepSettings,
  type WorkspacePrepSettingsView,
} from '../../../shared/workspacePrepSettings';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Switch from '../ui/Switch';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { IconWarning } from '../icons';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; view: WorkspacePrepSettingsView };

/** The ticks a first open starts with: what the file lists, or the `.env`
 *  family when copying was never configured. */
export function initialCopySelection(view: WorkspacePrepSettingsView): string[] {
  if (!view.copyUnset) return view.settings.copy;
  return view.candidates.filter(isDefaultCopyCandidate);
}

export default function WorkspacePrepDialog() {
  const t = useT();
  const wsId = useStore((s) => s.prepDialogWsId);
  const setWsId = useStore((s) => s.setPrepDialogWsId);
  const ws = useStore((s) => (wsId ? s.workspaces.find((w) => w.id === wsId) : undefined));
  const cwd = ws ? workspaceProbeCwd(ws) : undefined;

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [copy, setCopy] = useState<string[]>([]);
  const [setup, setSetup] = useState('');
  const [portRange, setPortRange] = useState('');
  const [copyIntoAutomated, setCopyIntoAutomated] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!wsId || !cwd) return;
    let live = true;
    setLoad({ state: 'loading' });
    setSaveError(null);
    window.electronAPI.projectConfig.prepGet(cwd).then(
      (view) => {
        if (!live) return;
        setLoad({ state: 'ready', view });
        setCopy(initialCopySelection(view));
        setSetup(view.settings.setup);
        setPortRange(view.settings.portRange);
        setCopyIntoAutomated(view.settings.copyIntoAutomated);
        setAdvanced(view.settings.portRange !== '' || view.settings.copyIntoAutomated);
      },
      () => { if (live) setLoad({ state: 'error' }); },
    );
    return () => { live = false; };
  }, [wsId, cwd]);

  const view = load.state === 'ready' ? load.view : undefined;
  // Files the project lists that this checkout does not have stay listed, so
  // unticking one is possible and "not found" is visible here too.
  const rows = useMemo(() => {
    if (!view) return [];
    const listed = new Set(view.candidates);
    return [...view.candidates, ...view.settings.copy.filter((f) => !listed.has(f))];
  }, [view]);

  if (!wsId) return null;
  const close = () => setWsId(null);
  const blocked = view?.saveBlocked;

  const save = async () => {
    if (!cwd || !view || blocked || saving) return;
    setSaving(true);
    setSaveError(null);
    const settings: WorkspacePrepSettings = { copy, setup, portRange: portRange.trim(), copyIntoAutomated };
    try {
      const r = await window.electronAPI.projectConfig.prepSave(cwd, settings, view.contentHash);
      if (r.ok) {
        void probeProjectConfig(wsId);
        close();
        return;
      }
      setSaveError(t(`prep.saveError.${r.error}` as never));
    } catch {
      setSaveError(t('prep.saveError.write-failed'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (file: string, on: boolean) =>
    setCopy((prev) => (on ? (prev.includes(file) ? prev : [...prev, file]) : prev.filter((f) => f !== file)));

  return (
    <Dialog onClose={close} closeOnBackdrop width={560} data-testid="workspace-prep-dialog">
      <DialogHeader
        title={t('prep.title')}
        description={view?.root ? <span className="ui-code">{view.root}</span> : t('prep.description')}
        closeLabel={t('project.close')}
      />
      <DialogBody>
        {!cwd && <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('prep.noFolder')}</p>}
        {cwd && load.state === 'loading' && <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('prep.loading')}</p>}
        {cwd && load.state === 'error' && <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('prep.saveError.write-failed')}</p>}
        {view && (
          <>
            {blocked && (
              <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3 text-[13px] leading-5" data-testid="prep-blocked">
                <span className="shrink-0 pt-[3px]" style={{ color: 'var(--accent-yellow)' }} aria-hidden="true">
                  <IconWarning size={14} />
                </span>
                <span className="text-[var(--text-main)]">{t(`prep.blocked.${blocked}` as never)}</span>
              </div>
            )}

            <section>
              <p className="ui-group-label">{t('prep.copyHeading')}</p>
              {rows.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--text-sub)]">{t('prep.copyEmpty')}</p>
              ) : (
                <div className="ui-group" data-testid="prep-copy-list">
                  {rows.map((file) => {
                    const missing = !view.candidates.includes(file);
                    return (
                      <label key={file} className="ui-row cursor-pointer">
                        <Checkbox
                          checked={copy.includes(file)}
                          onCheckedChange={(on) => toggle(file, on)}
                          aria-label={file}
                          disabled={!!blocked}
                        />
                        <div className="ui-row-text">
                          <p className="ui-row-title font-mono !text-[12px] break-all">{file}</p>
                          {missing && <p className="ui-row-detail">{t('prep.copyMissing')}</p>}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="mt-2 mb-0 text-[12px] text-[var(--text-sub)]">{t('prep.copyNote')}</p>
            </section>

            <section>
              <Field label={t('prep.setupLabel')} description={t('prep.setupDesc')} layout="stacked">
                <Input
                  value={setup}
                  onChange={(e) => setSetup(e.target.value)}
                  placeholder={view.suggestedSetup ?? ''}
                  className="font-mono text-[12px] w-full"
                  spellCheck={false}
                  disabled={!!blocked}
                  data-testid="prep-setup-input"
                />
              </Field>
              {setup.trim() === '' && view.suggestedSetup && !blocked && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSetup(view.suggestedSetup ?? '')}>
                  {t('prep.useSuggested', { command: view.suggestedSetup })}
                </Button>
              )}
            </section>

            <section>
              <Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
                {t('prep.advanced')}
              </Button>
              {advanced && (
                <div className="ui-group mt-2">
                  <Field label={t('prep.portLabel')} description={t('prep.portDesc')}>
                    <Input
                      value={portRange}
                      onChange={(e) => setPortRange(e.target.value)}
                      placeholder="3000-3010"
                      className="font-mono text-[12px] w-[140px]"
                      spellCheck={false}
                      disabled={!!blocked}
                    />
                  </Field>
                  <Field label={t('prep.automatedLabel')} description={t('prep.automatedRisk')}>
                    <Switch
                      checked={copyIntoAutomated}
                      onCheckedChange={setCopyIntoAutomated}
                      disabled={!!blocked}
                      data-testid="prep-automated-switch"
                    />
                  </Field>
                </div>
              )}
            </section>

            {saveError && <p className="m-0 text-[13px]" style={{ color: 'var(--accent-red)' }} role="alert">{saveError}</p>}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" onClick={close}>
          {t('project.close')}
        </Button>
        {blocked === 'review-first' ? (
          <Button size="md" variant="primary" onClick={() => { close(); useStore.getState().setProjectDialogWsId(wsId); }}>
            {t('prep.review')}
          </Button>
        ) : (
          view && !blocked && (
            <Button size="md" variant="primary" onClick={() => { void save(); }} data-testid="prep-save">
              {t('prep.save')}
            </Button>
          )
        )}
      </DialogFooter>
    </Dialog>
  );
}
