// Every custom scheme that needs privileges, registered in ONE call:
// `protocol.registerSchemesAsPrivileged` may only be called once, so a second
// call would silently strip whichever scheme it left out. Must run before
// `app.whenReady()` — called at module scope in main/index.ts.

import { protocol } from 'electron';
import { PLUGIN_SCHEME_PRIVILEGES } from './plugins/pluginProtocol';
import { PREVIEW_SCHEME_PRIVILEGES } from './preview/previewProtocol';
import { HTML_PREVIEW_SCHEME_PRIVILEGES } from './preview/previewHtml';

export const PRIVILEGED_SCHEMES = [PLUGIN_SCHEME_PRIVILEGES, PREVIEW_SCHEME_PRIVILEGES, HTML_PREVIEW_SCHEME_PRIVILEGES];

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);
}
