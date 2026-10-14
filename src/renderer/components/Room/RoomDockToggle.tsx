// Compatibility shim: the room dock and its titlebar toggle are gone (owner
// decision 2026-10-14). Renders nothing until the titlebar (StatusBar) drops
// the import, then this file goes.
export default function RoomDockToggle(): null {
  return null;
}
