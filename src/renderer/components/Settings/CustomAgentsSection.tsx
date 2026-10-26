// ─── Custom agents — agent CLIs wmux does not know, defined by the operator ──
// Main owns the list (src/main/worktask/customAgents.ts) and validates every
// save strictly; this section edits a draft, checks it with the same validator
// before sending, and shows main's refusal. The same shapes as Fan-out presets
// (rows with Edit / Delete, an inline stacked editor), and like them nothing
// here is a primary button. An agent a role or a preset still launches cannot
// be deleted: its row says what uses it.

import { useEffect, useState } from 'react';
import {
  CUSTOM_AGENTS_MAX,
  CUSTOM_AGENT_ARGS_MAX,
  CUSTOM_AGENT_COMMAND_MAX,
  CUSTOM_AGENT_FLAG_MAX,
  CUSTOM_AGENT_NAME_MAX,
  customAgentLaunchLine,
  customAgentStem,
  type CustomAgent,
  type CustomAgentDropped,
  type CustomAgentIssue,
} from '../../../shared/customAgents';
import type { FanoutPreset } from '../../../shared/fanoutPreset';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import { SettingsSection, SettingNote } from './SettingsLayout';
import {
  applyCustomAgentDraft,
  customAgentUsers,
  draftFromCustomAgent,
  emptyCustomAgentDraft,
  isCustomAgentUsed,
  type CustomAgentDraft,
  type CustomAgentUsers,
} from './customAgentDraft';

type Translate = ReturnType<typeof useT>;

/** Sent by the Fan-out presets section after a save, so "Used by" stays true. */
export const FANOUT_PRESETS_CHANGED_EVENT = 'wmux:fanout-presets-changed';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The editor label a validator's `field` param names. */
const FIELD_LABELS: Record<string, string> = {
  promptFlag: 'settings.customAgentsPromptFlag',
  modelFlag: 'settings.customAgentsModelFlag',
  unattendedFlags: 'settings.customAgentsUnattendedFlags',
};

/** A validator issue in the UI language (the English `error` is wire-only). */
function issueText(t: Translate, issue: CustomAgentIssue): string {
  const label = issue.params.field ? FIELD_LABELS[issue.params.field] : undefined;
  return t(`settings.customAgentsIssue.${issue.code}`, label ? { ...issue.params, field: t(label) } : issue.params);
}

export function CustomAgentsSection(): React.ReactElement {
  const t = useT();
  const agents = useStore((s) => s.customAgents);
  const setAgents = useStore((s) => s.setCustomAgents);
  const bindings = useStore((s) => s.orchestratorRoleBindings);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Entries main could not keep. The save replaces the whole file, so they are
  // shown until the operator saves (after which the backup holds them).
  const [dropped, setDropped] = useState<{ items: CustomAgentDropped[]; unreadable: boolean }>({ items: [], unreadable: false });
  const [presets, setPresets] = useState<FanoutPreset[]>([]);
  // index null = a new agent appended at the end.
  const [editing, setEditing] = useState<{ index: number | null; draft: CustomAgentDraft } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.fanout?.getCustomAgents?.()
      .then((report) => {
        if (cancelled || !report || !Array.isArray(report.agents)) return;
        setAgents(report.agents);
        setDropped({ items: Array.isArray(report.dropped) ? report.dropped : [], unreadable: report.unreadable === true });
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(t('settings.customAgentsLoadError', { error: errorText(err) }));
      });
    const loadPresets = () => {
      window.electronAPI?.fanout?.getPresets?.()
        .then((report) => {
          if (!cancelled && report && Array.isArray(report.presets)) setPresets(report.presets);
        })
        .catch(() => undefined); // main still refuses removing an agent a preset uses
    };
    loadPresets();
    window.addEventListener(FANOUT_PRESETS_CHANGED_EVENT, loadPresets);
    return () => {
      cancelled = true;
      window.removeEventListener(FANOUT_PRESETS_CHANGED_EVENT, loadPresets);
    };
  }, []);

  const usersOf = (stem: string): CustomAgentUsers => customAgentUsers(stem, bindings, presets);

  const persist = async (next: CustomAgent[]): Promise<boolean> => {
    setBusy(true);
    try {
      const out = await window.electronAPI.fanout.setCustomAgents(next);
      if (!out.ok) {
        setError(t('settings.customAgentsSaveError', { error: issueText(t, out) }));
        return false;
      }
      setAgents(out.agents);
      setDropped({ items: [], unreadable: false });
      setError('');
      return true;
    } catch (err) {
      setError(t('settings.customAgentsSaveError', { error: errorText(err) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (index: number | null, draft: CustomAgentDraft) => {
    setError('');
    setEditing({ index, draft });
  };

  const onSave = async () => {
    if (!editing) return;
    const r = applyCustomAgentDraft(agents, editing.draft, editing.index, usersOf);
    if (!r.ok) {
      setError(t('settings.customAgentsInvalid', { error: issueText(t, r.issue) }));
      return;
    }
    if (await persist(r.next)) setEditing(null);
  };

  const onCancel = () => {
    setEditing(null);
    setError('');
  };

  const editor = (draft: CustomAgentDraft) => (
    <CustomAgentEditor
      t={t}
      draft={draft}
      error={error}
      busy={busy}
      onChange={(next) => setEditing((cur) => (cur ? { ...cur, draft: next } : cur))}
      onSave={() => void onSave()}
      onCancel={onCancel}
    />
  );

  const atCap = agents.length >= CUSTOM_AGENTS_MAX;

  return (
    <SettingsSection
      id="customagents"
      title={t('settings.customAgents')}
      description={t('settings.customAgentsDesc')}
      data-testid="custom-agents-section"
    >
      {loadError && <SettingNote tone="danger" role="alert">{loadError}</SettingNote>}
      {dropped.unreadable && (
        <SettingNote tone="warning" data-testid="custom-agents-unreadable">{t('settings.customAgentsUnreadable')}</SettingNote>
      )}
      {dropped.items.length > 0 && (
        <SettingNote tone="warning" data-testid="custom-agents-dropped">
          {t('settings.customAgentsDropped', { count: String(dropped.items.length) })}
          {dropped.items.map((d, k) => (
            <span key={k} className="block">
              {t('settings.customAgentsDroppedItem', { name: d.name ?? '?', issue: issueText(t, d.issue) })}
            </span>
          ))}
        </SettingNote>
      )}
      {!loaded && !loadError && <SettingNote>{t('settings.customAgentsLoading')}</SettingNote>}
      {loaded && agents.length === 0 && editing?.index !== null && (
        <SettingNote>{t('settings.customAgentsEmpty')}</SettingNote>
      )}
      {agents.map((agent, k) =>
        editing?.index === k ? (
          <div key={agent.name}>{editor(editing.draft)}</div>
        ) : (
          <CustomAgentRow
            key={agent.name}
            t={t}
            agent={agent}
            users={usersOf(customAgentStem(agent))}
            disabled={busy || editing !== null}
            onEdit={() => startEdit(k, draftFromCustomAgent(agent))}
            onDelete={() => void persist(agents.filter((_, i) => i !== k))}
          />
        ),
      )}
      {editing && editing.index === null && editor(editing.draft)}
      {!editing && error && <SettingNote tone="danger" role="alert">{error}</SettingNote>}
      {loaded && !editing && !atCap && (
        <div className="ui-row">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              data-testid="custom-agent-add"
              onClick={() => startEdit(null, emptyCustomAgentDraft())}
            >
              {t('settings.customAgentsAdd')}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function CustomAgentRow({
  t,
  agent,
  users,
  disabled,
  onEdit,
  onDelete,
}: {
  t: Translate;
  agent: CustomAgent;
  users: CustomAgentUsers;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const used = isCustomAgentUsed(users);
  const usedBy = [
    ...users.roles.map((role) => t('settings.customAgentsUsedByRole', { role })),
    ...users.presets.map((name) => t('settings.customAgentsUsedByPreset', { name })),
  ].join(', ');
  return (
    <div className="ui-row" data-testid="custom-agent-row" data-custom-agent={customAgentStem(agent)}>
      <div className="ui-row-text">
        <p className="ui-row-title truncate">{agent.name}</p>
        {/* What gets launched: machine evidence, mono. */}
        <p className="ui-row-detail truncate font-mono">{customAgentLaunchLine(agent)}</p>
        <p className="ui-row-detail truncate" data-testid="custom-agent-unattended">
          {agent.unattendedFlags
            ? t('settings.customAgentsUnattended', { flags: agent.unattendedFlags })
            : t('settings.customAgentsUnattendedNone')}
        </p>
        {used && (
          <p className="ui-row-detail truncate" data-testid="custom-agent-used-by">
            {t('settings.customAgentsUsedBy', { users: usedBy })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" disabled={disabled} data-testid="custom-agent-edit" onClick={onEdit}>
          {t('settings.customAgentsEdit')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled || used}
          title={used ? t('settings.customAgentsDeleteBlocked') : undefined}
          data-testid="custom-agent-delete"
          onClick={onDelete}
        >
          {t('settings.customAgentsDelete')}
        </Button>
      </div>
    </div>
  );
}

function CustomAgentEditor({
  t,
  draft,
  error,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  t: Translate;
  draft: CustomAgentDraft;
  error: string;
  busy: boolean;
  onChange: (next: CustomAgentDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const text = (
    field: keyof CustomAgentDraft,
    label: string,
    description: string,
    opts: { max: number; placeholder?: string; mono?: boolean },
  ) => (
    <Field label={label} description={description} layout="stacked">
      <Input
        className={opts.mono === false ? 'settings-input' : 'settings-input font-mono'}
        value={draft[field]}
        maxLength={opts.max}
        placeholder={opts.placeholder}
        spellCheck={false}
        data-testid={`custom-agent-${field}`}
        onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
      />
    </Field>
  );
  const none = t('settings.customAgentsNone');
  return (
    <div className="settings-block" data-testid="custom-agent-editor">
      {text('name', t('settings.customAgentsName'), t('settings.customAgentsNameDesc'), { max: CUSTOM_AGENT_NAME_MAX, mono: false })}
      {text('command', t('settings.customAgentsCommand'), t('settings.customAgentsCommandDesc'), { max: CUSTOM_AGENT_COMMAND_MAX })}
      {text('args', t('settings.customAgentsArgs'), t('settings.customAgentsArgsDesc'), {
        max: CUSTOM_AGENT_ARGS_MAX,
        placeholder: t('settings.customAgentsOptional'),
      })}
      {text('promptFlag', t('settings.customAgentsPromptFlag'), t('settings.customAgentsPromptFlagDesc'), { max: CUSTOM_AGENT_FLAG_MAX, placeholder: none })}
      {text('modelFlag', t('settings.customAgentsModelFlag'), t('settings.customAgentsModelFlagDesc'), { max: CUSTOM_AGENT_FLAG_MAX, placeholder: none })}
      {text('unattendedFlags', t('settings.customAgentsUnattendedFlags'), t('settings.customAgentsUnattendedFlagsDesc'), {
        max: CUSTOM_AGENT_ARGS_MAX,
        placeholder: none,
      })}
      {error && <SettingNote tone="danger" role="alert" className="!p-0" data-testid="custom-agent-error">{error}</SettingNote>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="md" disabled={busy} data-testid="custom-agent-cancel" onClick={onCancel}>
          {t('settings.customAgentsCancel')}
        </Button>
        <Button variant="secondary" size="md" disabled={busy} data-testid="custom-agent-save" onClick={onSave}>
          {t('settings.customAgentsSave')}
        </Button>
      </div>
    </div>
  );
}
