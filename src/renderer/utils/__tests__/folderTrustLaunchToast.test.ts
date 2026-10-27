// The Resume pill and chip say why their line was not typed when main refused
// it at an agent's folder-trust prompt, and stay quiet about other refusals.
import { describe, expect, it, vi } from 'vitest';

const pushToast = vi.fn();
vi.mock('../../stores', () => ({ useStore: { getState: () => ({ pushToast }) } }));

import { toastFolderTrustLaunchRefusal } from '../folderTrustLaunchToast';
import { t } from '../../i18n';

describe('toastFolderTrustLaunchRefusal', () => {
  it('toasts a refusal at a folder-trust prompt, as the invoke error reaches the renderer', () => {
    const err = new Error("Error invoking remote method 'pty:write-launch': Error: PTY_WRITE_LAUNCH: the pane is on a folder-trust prompt; answer it in the pane");
    expect(toastFolderTrustLaunchRefusal(err)).toBe(true);
    expect(pushToast).toHaveBeenCalledWith({ level: 'warn', message: t('pane.launchAtFolderTrust') });
  });

  it('says nothing for any other refusal', () => {
    pushToast.mockClear();
    expect(toastFolderTrustLaunchRefusal(new Error('PTY_WRITE_LAUNCH: a chat owns this pane, so nothing was typed'))).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
  });
});
