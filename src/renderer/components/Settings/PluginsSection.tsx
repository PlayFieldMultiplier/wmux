import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import Button from '../ui/Button';
import { SettingRow, SettingsSection } from './SettingsLayout';

/**
 * Settings › Plugins keeps only a way to the Plugins rail page, where
 * plugins and connectors are installed, approved and managed (2026-10-21).
 */
export default function PluginsSection() {
  const t = useT();
  return <SettingsSection id="plugins">
    <SettingRow label={t('plugins.settings.moved')} description={t('plugins.settings.description')}>
      <Button onClick={() => useStore.getState().setAppRoute('plugins')}>{t('plugins.settings.open')}</Button>
    </SettingRow>
  </SettingsSection>;
}
