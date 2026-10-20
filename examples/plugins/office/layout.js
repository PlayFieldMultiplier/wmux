// Pure layout for the Office page, no DOM: who the employees are (from an
// agent.state snapshot), the room's size, the boss desk at the head of the
// room with a queue in front of it for employees who need you or have
// finished, one desk per employee (kept while its owner queues or rests),
// sofas for resting employees, and the room pieces to draw.
//
// World units follow the art: one floor tile is 16x16 units, `a` runs
// down-right along the right (back) wall, `b` down-left along the left wall,
// and a floor point (a, b) lands at screen ((a - b), (a + b) / 2) at 1x. Every
// point returned here is a 1x screen pixel relative to the room's top-left;
// the page multiplies by its display scale.
'use strict';
(function (root) {
  /** Desks per row: the room's width is fixed, it grows by rows. */
  const DESK_COLUMNS = 5;
  /** Rows of desks the room always has. */
  const BASE_DESK_ROWS = 2;

  const TILE = 16;
  const DESK_A0 = 32;
  const DESK_A_STEP = 48;
  const DESK_B_STEP = 56;
  /** Desk (1 tile) plus the chair's tile in front of it. */
  const STATION_DEPTH = 32;
  /** Room length along `a` (the back wall). */
  const ROOM_A = DESK_A0 + (DESK_COLUMNS - 1) * DESK_A_STEP + 2 * TILE + TILE;

  /** The boss desk's footprint from its north corner, and its chair's reach towards the back wall. */
  const BOSS_DESK = { a: 48, b: 20, chair: 20 };
  /** Centred on the back wall, under its windows, the chair against the wall. */
  const BOSS_A0 = ROOM_A / 2 - BOSS_DESK.a / 2;
  const BOSS_B0 = BOSS_DESK.chair + 4;
  /**
   * Queue rows run parallel to the boss desk's front, each filled from the
   * spot nearest the boss towards the left wall. Alternate rows sit half a
   * step over, so a status bubble never lands on the head of the one behind.
   */
  const QUEUE_COLUMNS = 4;
  const QUEUE_STEP_A = 48;
  const QUEUE_ROW_B = 64;
  const QUEUE_START_A = BOSS_A0 + BOSS_DESK.a / 2 + 16;
  // The first row stands far enough out that it does not hide the boss.
  const QUEUE_B0 = BOSS_B0 + BOSS_DESK.b + 56;
  const BASE_QUEUE_ROWS = 2;
  /** From the last queue row to the first desk row: clear of the monitors and bubbles. */
  const QUEUE_TO_DESKS = 56;

  /** Sofas the lounge always has; it adds whole sofas until every resting employee sits. */
  const BASE_SOFAS = 3;
  const SOFAS_PER_ROW = 3;
  const SOFA_A0 = 40;
  const SOFA_A_STEP = 80;
  /** One sofa row: the sofa, the rug and coffee table in front, and a gap. */
  const SOFA_B_STEP = 64;
  /** From the last sofa row to the front wall: the rug and the front plants. */
  const LOUNGE_FRONT = 36;
  /** Sofa-seat world offsets from the sofa's anchor. */
  const SOFA_SEAT_OFFSETS = [{ a: 13, b: 11 }, { a: 35, b: 11 }];

  const PAD_X = 24;
  /** Above the back corner: wall height plus room for the back row's bubbles. */
  const PAD_TOP = 72;
  /** Below the front corner: name labels of the front row. */
  const PAD_BOTTOM = 40;

  const STATES = ['working', 'needsYou', 'finished', 'resting'];

  /** Depth band -> CSS z-index: floor 1-2, walls 10+, objects above. */
  function stackIndex(depth, step) {
    return 1000 + Math.round(depth) * 4 + step;
  }

  const roundUp = (v, unit) => Math.ceil(v / unit) * unit;

  function deskCell(index) {
    return { row: Math.floor(index / DESK_COLUMNS), col: index % DESK_COLUMNS };
  }

  /** FNV-1a: a small, stable, well-spread string hash (picks a look). */
  function hashLook(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * One employee per pane surface that has an agent. The pane's state and
   * label apply to all of its surfaces. Where two employees would read the
   * same, the agent's name is added; where that still collides, a number.
   */
  function employeesFromSnapshot(snapshot) {
    const out = [];
    for (const pane of (snapshot && Array.isArray(snapshot.panes) ? snapshot.panes : [])) {
      if (!pane || !STATES.includes(pane.state) || !Array.isArray(pane.surfaces)) continue;
      for (const surface of pane.surfaces) {
        if (!surface || typeof surface.surfaceId !== 'string' || !surface.agentName) continue;
        out.push({
          id: surface.surfaceId,
          paneId: pane.paneId,
          label: String(pane.label || surface.agentName),
          agent: String(surface.agentName),
          state: pane.state,
          stashed: pane.stashed === true,
          look: hashLook(surface.surfaceId),
        });
      }
    }
    const step = (make) => {
      const counts = new Map();
      for (const e of out) counts.set(e.label, (counts.get(e.label) || 0) + 1);
      const seen = new Map();
      for (const e of out) {
        if (counts.get(e.label) < 2) continue;
        const k = (seen.get(e.label) || 0) + 1;
        seen.set(e.label, k);
        e.next = make(e, k);
      }
      for (const e of out) if (e.next !== undefined) { e.label = e.next; delete e.next; }
    };
    step((e) => `${e.label} · ${e.agent}`);
    step((e, k) => `${e.label} · ${k}`);
    return out;
  }

  /** Each employee keeps its previous desk; newcomers take the first free one. */
  function assignDesks(employees, prev) {
    const deskFor = {};
    const taken = new Set();
    if (prev) {
      for (const e of employees) {
        const desk = prev.deskFor[e.id];
        if (desk !== undefined && !taken.has(desk)) {
          deskFor[e.id] = desk;
          taken.add(desk);
        }
      }
    }
    let next = 0;
    for (const e of employees) {
      if (deskFor[e.id] !== undefined) continue;
      while (taken.has(next)) next += 1;
      deskFor[e.id] = next;
      taken.add(next);
    }
    return deskFor;
  }

  function queueGroup(e) {
    return e.state === 'needsYou' || e.state === 'finished' ? e.state : null;
  }

  /**
   * The queue: needs-you first, then finished, which start a row of their
   * own; within a group, by when each joined it. An employee keeps its stamp
   * while it stays in its group, so it keeps its place; a newcomer (or one
   * that changed group) joins the back. Spot k is row floor(k / QUEUE_COLUMNS).
   */
  function assignQueue(employees, prev) {
    const queueSince = {};
    let queueSeq = prev ? prev.queueSeq : 0;
    for (const e of employees) {
      const group = queueGroup(e);
      if (!group) continue;
      const old = prev && prev.queueSince[e.id];
      queueSince[e.id] = old && old.group === group ? old : { group, seq: queueSeq++ };
    }
    const byGroup = (g) => Object.keys(queueSince)
      .filter((id) => queueSince[id].group === g)
      .sort((x, y) => queueSince[x].seq - queueSince[y].seq);
    const needs = byGroup('needsYou');
    const finished = byGroup('finished');
    const needRows = Math.ceil(needs.length / QUEUE_COLUMNS);
    const queueFor = {};
    needs.forEach((id, k) => { queueFor[id] = k; });
    finished.forEach((id, k) => { queueFor[id] = needRows * QUEUE_COLUMNS + k; });
    return { queueFor, queueSince, queueSeq, rows: needRows + Math.ceil(finished.length / QUEUE_COLUMNS) };
  }

  /** Sofa spots for the resting: each keeps its previous one, newcomers fill the freed spots first. */
  function assignLounge(resting, prev) {
    const loungeFor = {};
    const taken = new Set();
    if (prev) {
      for (const e of resting) {
        const spot = prev.loungeFor[e.id];
        if (spot !== undefined && !taken.has(spot)) {
          loungeFor[e.id] = spot;
          taken.add(spot);
        }
      }
    }
    let next = 0;
    for (const e of resting) {
      if (loungeFor[e.id] !== undefined) continue;
      while (taken.has(next)) next += 1;
      loungeFor[e.id] = next;
      taken.add(next);
    }
    return loungeFor;
  }

  /**
   * Lay out the room for `employees`, continuing from `prev` (the last
   * layout of this page) so that nobody changes desk, sofa or queue place
   * just because someone else came or went.
   */
  function layoutOffice(employees, prev) {
    const deskFor = assignDesks(employees, prev);
    const maxDesk = Object.values(deskFor).reduce((m, d) => Math.max(m, d), -1);
    const rows = Math.max(BASE_DESK_ROWS, Math.ceil((maxDesk + 1) / DESK_COLUMNS));

    const queue0 = assignQueue(employees, prev);
    // The queue area only grows while the page is open, so the desks behind
    // it do not shift back and forth as people come and go.
    const queueRows = Math.max(BASE_QUEUE_ROWS, queue0.rows, prev ? prev.queueRows : 0);
    const deskB0 = QUEUE_B0 + (queueRows - 1) * QUEUE_ROW_B + QUEUE_TO_DESKS;

    const loungeFor = assignLounge(employees.filter((e) => e.state === 'resting'), prev);
    // Kept spots can leave holes, so count sofas by the highest spot: a sofa
    // stays while anyone sits on it, and each sofa keeps its place.
    const loungeSpots = Object.values(loungeFor).reduce((m, spot) => Math.max(m, spot + 1), 0);
    const sofas = Math.max(BASE_SOFAS, Math.ceil(loungeSpots / SOFA_SEAT_OFFSETS.length));
    const sofaRows = Math.ceil(sofas / SOFAS_PER_ROW);

    const deskEnd = deskB0 + (rows - 1) * DESK_B_STEP + STATION_DEPTH;
    const loungeB = roundUp(deskEnd + 8, TILE);
    const roomA = ROOM_A;
    const roomB = roundUp(loungeB + 8 + sofaRows * SOFA_B_STEP + LOUNGE_FRONT, TILE);

    const toScreen = (a, b) => ({ x: a - b + roomB + PAD_X, y: (a + b) / 2 + PAD_TOP });

    const desks = [];
    for (let d = 0; d < rows * DESK_COLUMNS; d += 1) {
      const { row, col } = deskCell(d);
      const a = DESK_A0 + col * DESK_A_STEP;
      const b = deskB0 + row * DESK_B_STEP;
      desks.push({ ...toScreen(a, b), z: a + b + 42, spot: 'desk' });
    }

    const queue = [];
    for (let k = 0; k < queueRows * QUEUE_COLUMNS; k += 1) {
      const row = Math.floor(k / QUEUE_COLUMNS);
      const a = QUEUE_START_A - (k % QUEUE_COLUMNS) * QUEUE_STEP_A + (row % 2) * (QUEUE_STEP_A / 2);
      const b = QUEUE_B0 + row * QUEUE_ROW_B;
      queue.push({ ...toScreen(a, b), z: a + b, spot: 'queue' });
    }
    const boss = { ...toScreen(BOSS_A0, BOSS_B0), z: BOSS_A0 + BOSS_DESK.a / 2 + BOSS_B0 + BOSS_DESK.b };

    const props = [];
    const prop = (key, a, b, zIndex) => { props.push({ key, ...toScreen(a, b), zIndex }); };

    const lounge = [];
    // Sofas in rows of three; each row has a rug and coffee table at its
    // middle sofa (at its only sofa while the last row has one).
    for (let s = 0; s < sofas; s += 1) {
      const col = s % SOFAS_PER_ROW;
      const rowLength = Math.min(SOFAS_PER_ROW, sofas - (s - col));
      const a = SOFA_A0 + col * SOFA_A_STEP;
      const b = loungeB + 8 + Math.floor(s / SOFAS_PER_ROW) * SOFA_B_STEP;
      const depth = a + 20 + b + 4;
      prop('sofa', a, b, stackIndex(depth, 0));
      SOFA_SEAT_OFFSETS.forEach((o, k) => {
        lounge.push({ ...toScreen(a + o.a, b + o.b), z: depth + k + 1, spot: 'sofa' });
      });
      if (col === Math.min(1, rowLength - 1)) {
        prop('rug', a - 4, b + 16, 3);
        prop('coffeeTable', a + 6, b + 24, stackIndex(a + 14 + b + 30, 0));
      }
    }

    // Floor: wood everywhere, a carpet under the desk area.
    const tilesA = roomA / TILE;
    const tilesB = roomB / TILE;
    const carpetFrom = Math.floor((deskB0 - 8) / TILE);
    const carpetRows = Math.ceil((deskEnd + 8) / TILE);
    for (let j = 0; j < tilesB; j += 1) {
      for (let i = 0; i < tilesA; i += 1) {
        const carpet = i >= 1 && i < tilesA - 1 && j >= carpetFrom && j < carpetRows;
        prop(carpet ? 'carpet' : 'floor', i * TILE, j * TILE, 1);
      }
    }
    // Walls: windows in pairs along the back wall, two in every six tiles on the left.
    for (let i = 0; i < tilesA; i += 1) prop(i % 3 === 0 ? 'wall' : 'window', i * TILE, 0, 10 + (tilesA - i));
    for (let j = 0; j < tilesB; j += 1) {
      prop(j % 6 === 3 || j % 6 === 4 ? 'windowLeft' : 'wallLeft', 0, j * TILE, 10 + (tilesB - j));
    }

    // Decor, with a plant on each side of the boss desk.
    prop('shelf', roomA - 40, 0, stackIndex(roomA - 40 + 24 + 4, 0));
    prop('plant', 6, 6, stackIndex(12, 0));
    prop('plant', BOSS_A0 - 14, 10, stackIndex(BOSS_A0 - 14 + 16, 0));
    prop('plant', BOSS_A0 + BOSS_DESK.a + 14, 10, stackIndex(BOSS_A0 + BOSS_DESK.a + 14 + 16, 0));
    prop('plant', roomA - 10, 6, stackIndex(roomA - 4, 0));
    prop('plant', 6, roomB - 10, stackIndex(roomB - 4, 0));
    prop('plant', roomA - 10, roomB - 10, stackIndex(roomA + roomB - 20, 0));

    return {
      width: roomA + roomB + 2 * PAD_X,
      height: (roomA + roomB) / 2 + PAD_TOP + PAD_BOTTOM,
      desks,
      queue,
      lounge,
      deskFor,
      queueFor: queue0.queueFor,
      queueSince: queue0.queueSince,
      queueSeq: queue0.queueSeq,
      queueRows,
      loungeFor,
      boss,
      props,
    };
  }

  /**
   * Where an employee belongs now. `key` names the spot, not its pixels, so
   * a room that grows (and moves every spot on screen) is not a walk.
   */
  function spotFor(employee, layout) {
    const pick = (kind, seats, index) => {
      const seat = index === undefined ? undefined : seats[index];
      return seat ? { seat, kind, key: `${kind}:${index}` } : null;
    };
    if (employee.state === 'working') return pick('desk', layout.desks, layout.deskFor[employee.id]);
    if (employee.state === 'resting') return pick('sofa', layout.lounge, layout.loungeFor[employee.id]);
    return pick('queue', layout.queue, layout.queueFor[employee.id]);
  }

  root.OfficeLayout = {
    DESK_COLUMNS, BASE_DESK_ROWS, QUEUE_COLUMNS, BASE_SOFAS,
    stackIndex, hashLook, employeesFromSnapshot, layoutOffice, spotFor,
  };
})(this);
