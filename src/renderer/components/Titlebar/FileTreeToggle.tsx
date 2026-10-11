import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconFileTree } from '../icons';
import { displayCombo, effectiveBindings } from '../../../shared/keymap';
import { toggleFileTreePanel } from '../FileTree/fileTreeToggle';

/**
 * The file tree column's show/hide toggle, at the titlebar's right end just
 * before Moa's button. A bare icon like the other panel toggles: no fill at
 * rest or when on, `aria-pressed` carries the state (pressed only while the
 * column is on screen, i.e. on the Workspaces page).
 */
export default function FileTreeToggle() {
  const t = useT();
  const onScreen = useStore((s) => s.fileTreeVisible && s.appRoute === 'workspaces');
  const overrides = useStore((s) => s.shortcutOverrides);
  const platform = (typeof window === 'undefined' ? undefined : window.electronAPI?.platform) ?? 'linux';
  const combo = effectiveBindings(platform, overrides).find((b) => b.action === 'toggleFileTree')?.combo;
  const action = onScreen ? t('filetree.toggleHide') : t('filetree.toggleShow');
  return (
    <button
      type="button"
      className={`wmux-panel-toggle ${FOCUS_RING}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      onClick={() => toggleFileTreePanel(useStore.getState())}
      title={combo ? `${action} (${displayCombo(combo, platform)})` : action}
      aria-label={t('filetree.toggleShow')}
      aria-pressed={onScreen}
      aria-controls="wmux-file-tree"
      data-file-tree-toggle
    >
      <IconFileTree size={16} />
    </button>
  );
}
