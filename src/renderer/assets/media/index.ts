// Short muted loops for the welcome dialog (and any tour step), cut from
// recordings of isolated wmux instances (VP9 WebM, 640x400, 10 fps, no audio).
// Each clip shows what wmux tells you, matching the copy next to it, and has a
// still poster for reduced motion and for the frame before playback starts.
import statuslineSrc from './statusline.webm';
import statuslinePoster from './statusline-poster.webp';

export interface MediaClip {
  src: string;
  poster: string;
}

export type MediaClipId = 'statusline';

export const MEDIA_CLIPS: Record<MediaClipId, MediaClip> = {
  /** Claude Code's line under the input box: model, account, context, then 5h / 7d usage once the first reply lands. */
  statusline: { src: statuslineSrc, poster: statuslinePoster },
};

// One still per Plugins catalog entry: a real capture of that plugin's own
// rail page in the light theme (isolated instance, fake agents, 1280x800).
import officePreview from './plugin-office.webp';
import agentStatePreview from './plugin-agent-state-page.webp';

export type PluginPreviewId = 'office' | 'agent-state-page';

export const PLUGIN_PREVIEWS: Record<PluginPreviewId, string> = {
  office: officePreview,
  'agent-state-page': agentStatePreview,
};
