import type { WebContents, WebFrameMain } from 'electron';
import { PLUGIN_FRAME_IPC, PLUGIN_NAME_REGEX, PLUGIN_PROTOCOL_SCHEME } from '../../shared/pluginHost';

/** Only the plugin's own bundle may supply a document to its bridge. */
export function isPluginBundleUrl(pluginName: string, value: string): boolean {
  try {
    const url = new URL(value);
    return PLUGIN_NAME_REGEX.test(pluginName) && url.protocol === `${PLUGIN_PROTOCOL_SCHEME}:`
      && url.hostname === pluginName && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function framePlugin(name: string): string | null {
  const match = /^wmux-plugin-frame:([^:]+):[a-zA-Z0-9-]+$/.exec(name);
  return match && PLUGIN_NAME_REGEX.test(match[1]) ? match[1] : null;
}

/** Install before loading the owner window. Webviews use separate WebContents. */
export function attachPluginFrameNavigation(contents: WebContents): void {
  const bindings = new Map<number, { name: string; plugin: string }>();
  const bindingFor = (frame: WebFrameMain | null) => {
    if (!frame || frame.parent !== contents.mainFrame) return null;
    const existing = bindings.get(frame.frameTreeNodeId);
    if (existing) return existing;
    const plugin = framePlugin(frame.name);
    if (!plugin) return null;
    // Keep only live direct children; a closed page must not accumulate a
    // binding for the lifetime of the owner window.
    const live = new Set(contents.mainFrame.frames.map((child) => child.frameTreeNodeId));
    live.add(frame.frameTreeNodeId);
    for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id);
    const binding = { name: frame.name, plugin };
    bindings.set(frame.frameTreeNodeId, binding);
    return binding;
  };
  const guard = (event: Electron.Event<{ isMainFrame: boolean; frame: WebFrameMain | null; url: string }>) => {
    if (event.isMainFrame) return;
    try {
      const binding = bindingFor(event.frame);
      if (!binding || !isPluginBundleUrl(binding.plugin, event.url)) event.preventDefault();
    } catch { event.preventDefault(); }
  };
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame || event.isSameDocument) return;
    try {
      const binding = bindingFor(event.frame);
      // A refused navigation never loads a replacement document. Preserve
      // its live bridge; otherwise the visible page would silently stop.
      if (binding && isPluginBundleUrl(binding.plugin, event.url)) contents.send(PLUGIN_FRAME_IPC.navigated, binding.name);
    } catch { /* A detached frame no longer has a bridge recipient. */ }
  });
  // Unlike the DOM src attribute, this URL is the committed frame document.
  // Refuse duplicate/missing names and non-owner callers rather than guessing.
  contents.ipc.handle(PLUGIN_FRAME_IPC.ready, async (event, pluginName: unknown, frameName: unknown, nonce: unknown) => {
    if (event.senderFrame !== contents.mainFrame || typeof pluginName !== 'string'
      || typeof frameName !== 'string' || framePlugin(frameName) !== pluginName
      || typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) return false;
    try {
      const frames = contents.mainFrame.frames.filter((frame) => frame.name === frameName);
      if (frames.length !== 1) return false;
      const frame = frames[0];
      const binding = bindingFor(frame);
      if (binding?.name !== frameName || binding.plugin !== pluginName || !isPluginBundleUrl(pluginName, frame.url)) return false;
      return await frame.executeJavaScript(pluginBridgeBootstrap(pluginName, nonce, new URL(contents.mainFrame.url).origin)) === true;
    } catch { return false; }
  });
  contents.once('destroyed', () => bindings.clear());
}

/**
 * The channel is created in the checked document, never sent through a later
 * WindowProxy lookup. A navigation between IPC validation and execution is
 * checked again synchronously here; later navigation cannot inherit this port.
 * Keep the v1 init shape/source for existing plugins. This host-dispatched
 * initialization event is synthetic (isTrusted=false).
 */
export function pluginBridgeBootstrap(pluginName: string, nonce: string, ownerOrigin: string): string {
  return `(() => {
    if (location.protocol !== 'wmux-plugin:' || location.host !== ${JSON.stringify(pluginName)}
      || !location.href.startsWith(${JSON.stringify(`wmux-plugin://${pluginName}/`)})) return false;
    const channel = new MessageChannel();
    parent.postMessage({ kind: 'wmux-plugin-bridge', nonce: ${JSON.stringify(nonce)} }, '*', [channel.port1]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { v: 1, kind: 'init' }, source: parent, origin: ${JSON.stringify(ownerOrigin)}, ports: [channel.port2]
    }));
    return true;
  })()`;
}
