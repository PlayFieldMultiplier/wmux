// The titlebar's toggle for the room dock while the agent factory is on (it
// stands where Moa's icon stands with the factory off; one panel, one
// toggle). A bare icon like the other panel toggles: the open state is
// aria-expanded, never a fill. From Settings it opens the dock on
// Workspaces; beside any other rail page it opens in place.
import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconMessage } from '../icons';
import { dockShownOn } from '../Layout/pagesBesideDock';
import { showWorkspaces } from '../../utils/showWorkspaces';

export default function RoomDockToggle(): React.ReactElement {
  const t = useT();
  const onScreen = useStore((s) => s.channelDockVisible && dockShownOn(s.appRoute));
  return (
    <button
      type="button"
      className={`wmux-panel-toggle ${FOCUS_RING}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      onClick={() => {
        const st = useStore.getState();
        if (onScreen) {
          st.setChannelDockVisible(false);
          return;
        }
        if (!dockShownOn(st.appRoute)) showWorkspaces(st);
        st.setChannelDockVisible(true);
      }}
      title={t('room.dock.toggle')}
      aria-label={t('room.dock.toggle')}
      aria-expanded={onScreen}
      aria-controls="wmux-tools-panel"
      data-testid="room-dock-toggle"
    >
      <IconMessage size={16} />
    </button>
  );
}
