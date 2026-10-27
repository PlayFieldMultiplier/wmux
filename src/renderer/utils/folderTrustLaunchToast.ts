import { useStore } from '../stores';
import { t } from '../i18n';
import { FOLDER_TRUST_LAUNCH_REFUSAL } from '../../shared/folderTrustWording';

/**
 * Tell the person why a line they clicked to type was not typed, when main
 * refused it at an agent's folder-trust prompt. Whether it did.
 */
export function toastFolderTrustLaunchRefusal(err: unknown): boolean {
  if (!String(err).includes(FOLDER_TRUST_LAUNCH_REFUSAL)) return false;
  useStore.getState().pushToast({ level: 'warn', message: t('pane.launchAtFolderTrust') });
  return true;
}
