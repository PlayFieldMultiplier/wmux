// Adapted from LibreChat (MIT), revision e081b566a42d3a83b8102157bd7806cf4ff63b17.
// client/src/components/SidePanel/MCPBuilder/MCPServerDialog/utils/urlUtils.ts
// Copyright (c) 2026 LibreChat. See src/renderer/components/Connectors/LICENSE.LibreChat
// and THIRD_PARTY_NOTICES. Function behavior unchanged; main validates every URL.
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }

  // If no protocol, assume https
  if (!trimmed.includes('://')) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

