import { useState } from 'react';
import type { A2aSpawnPolicyV1 } from '../../../shared/a2aSpawn';
import { useT } from '../../hooks/useT';
import Checkbox from '../ui/Checkbox';
import { REMOTE_SPAWN_UI_ENABLED } from './remoteSpawnFlag';
import { hostAllowed, withHostAllowed, type SpawnPolicySaveResult } from './remoteSpawnPolicy';

export interface RemoteSpawnHostToggleProps {
  hostId: string;
  /** That PC's name, for the accessible label. */
  name: string;
  /** This PC's policy as last read; nothing is drawn before the first read. */
  policy: A2aSpawnPolicyV1 | null;
  /** Saves the whole policy (the page applies what the daemon returns). */
  onSave: (next: A2aSpawnPolicyV1) => Promise<SpawnPolicySaveResult>;
  /** A refused save; the row shows it. */
  onError: (message: string) => void;
  /** Defaults to the feature flag; tests pass it. */
  enabled?: boolean;
}

/**
 * The Remote page's per-PC permission slot for starting new agents: whether
 * that PC may ask this PC to start one. Off for a PC never opted in.
 */
export default function RemoteSpawnHostToggle({ enabled = REMOTE_SPAWN_UI_ENABLED, ...props }: RemoteSpawnHostToggleProps) {
  if (!enabled || !props.policy) return null;
  return <HostToggle {...props} policy={props.policy} />;
}

function HostToggle({ hostId, name, policy, onSave, onError }: Omit<RemoteSpawnHostToggleProps, 'enabled'> & { policy: A2aSpawnPolicyV1 }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const checked = hostAllowed(policy, hostId);
  const change = async (allowed: boolean) => {
    setBusy(true);
    try {
      const r = await onSave(withHostAllowed(policy, hostId, allowed));
      if (!r.ok) onError(r.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="inline-flex items-center gap-1.5" data-remote-spawn-host={hostId}>
      <Checkbox
        checked={checked}
        disabled={busy}
        onCheckedChange={(v) => void change(v)}
        aria-label={t('remoteSpawn.hostToggleLabel', { name })}
      />
      <span>{t('remoteSpawn.hostToggle')}</span>
    </label>
  );
}
