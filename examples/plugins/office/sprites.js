// Sprite rectangles for characters.png and furniture.png, copied from the
// layout.generated.ts that scripts/office-art/build-office-art.mjs writes
// next to the sheets (see README.md). Keep the two in step when the art is rebuilt.
'use strict';
(function (root) {
  root.OfficeSprites = {
    /** furniture.png: sprite rectangle and the pixel that sits on its floor anchor. */
    furniture: {
      desk: { x: 0, y: 0, w: 64, h: 56, anchorX: 28, anchorY: 26 },
      monitorOff: { x: 66, y: 0, w: 64, h: 56, anchorX: 28, anchorY: 26 },
      monitorOn: { x: 132, y: 0, w: 64, h: 56, anchorX: 28, anchorY: 26 },
      chair: { x: 198, y: 0, w: 64, h: 56, anchorX: 28, anchorY: 26 },
      floor: { x: 0, y: 58, w: 32, h: 16, anchorX: 16, anchorY: 0 },
      carpet: { x: 34, y: 58, w: 32, h: 16, anchorX: 16, anchorY: 0 },
      wall: { x: 68, y: 58, w: 20, h: 63, anchorX: 0, anchorY: 54 },
      window: { x: 90, y: 58, w: 20, h: 63, anchorX: 0, anchorY: 54 },
      wallLeft: { x: 112, y: 58, w: 20, h: 63, anchorX: 20, anchorY: 54 },
      windowLeft: { x: 134, y: 58, w: 20, h: 63, anchorX: 20, anchorY: 54 },
      plant: { x: 156, y: 58, w: 22, h: 27, anchorX: 11, anchorY: 26 },
      shelf: { x: 180, y: 58, w: 38, h: 66, anchorX: 10, anchorY: 46 },
      sofa: { x: 0, y: 126, w: 72, h: 52, anchorX: 18, anchorY: 24 },
      coffeeTable: { x: 74, y: 126, w: 36, h: 30, anchorX: 14, anchorY: 12 },
      rug: { x: 112, y: 126, w: 80, h: 41, anchorX: 32, anchorY: 0 },
      bossDesk: { x: 0, y: 180, w: 96, h: 88, anchorX: 24, anchorY: 50 },
    },
    /** characters.png: one row per look, one 64x56 frame per pose, columns in this order. */
    looks: ['spiky', 'bob', 'curly', 'long', 'bun', 'ponytail', 'beanie', 'sidepart', 'hood'],
    poses: ['sit', 'type1', 'type2', 'raiseHand', 'rest1', 'rest2', 'walk1', 'walk2', 'standRaise'],
    frame: { w: 64, h: 56 },
    /** The look for agents other than Claude Code and Codex (hood up). */
    genericLook: 'hood',
    /** Desk, monitors, chair and every character frame share this frame and origin. */
    station: { w: 64, h: 56, deskX: 28, deskY: 26, seatX: 22, seatY: 49 },
    /** characters.png: the seated boss, sharing the bossDesk sprite's frame. */
    boss: { x: 0, y: 504, w: 96, h: 88, deskX: 24, deskY: 50, seatX: 58, seatY: 57 },
  };
})(this);
