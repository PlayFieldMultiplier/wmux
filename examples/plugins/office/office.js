// The Office page: the plugin bridge, and the room drawn as layered DOM
// sprites with names and bubbles as DOM text. Needs sprites.js and layout.js.
'use strict';
(function () {
  const { furniture: FURNITURE, looks: LOOKS, poses: POSES, frame: FRAME, genericLook, station: STATION, boss: BOSS } = self.OfficeSprites;
  const { layoutOffice, employeesFromSnapshot, spotFor, stackIndex } = self.OfficeLayout;

  /** Every user-facing string, in one place. */
  const STRINGS = {
    connecting: 'Connecting…',
    loading: 'Loading workspace…',
    unavailable: 'Agent state unavailable. Reopen this page to retry.',
    truncated: 'Some agents were omitted by the size limit.',
    empty: 'No local agents in this workspace',
    emptyHint: 'Start Claude Code or Codex in a pane and it takes a desk here.',
    focusFailed: 'Could not open that pane.',
    room: (count) => `Office, ${count} ${count === 1 ? 'agent' : 'agents'}`,
    bossPlate: 'Boss',
    bossLabel: 'Boss desk (you)',
    needsYou: 'Needs you',
    done: 'Done',
    state: { working: 'Working', needsYou: 'Needs you', finished: 'Finished', resting: 'Resting' },
    stashed: 'stashed',
    employee: (e, state) => `${e.label}, ${e.agent}: ${state}${e.stashed ? ` (${STRINGS.stashed})` : ''}`,
  };

  /** Display scale: the art is drawn at 1x and meant to be seen at 2x. */
  const SCALE = 2;
  /** Status bubbles sit above every sprite and name, and stack by depth among themselves. */
  const LABEL_Z = 110000;
  const STATUS_BUBBLE_Z = 110001;
  /** From the boss's anchor up to the nameplate's top, in 1x px. */
  const BOSS_PLATE_RISE = 46;
  /** A walk between spots; keep in step with the transition in index.html. */
  const WALK_MS = 900;
  const SHEETS = { characters: 'characters.png', furniture: 'furniture.png' };

  const room = document.querySelector('#room');
  const roomLayer = document.querySelector('#room-props');
  const stationLayer = document.querySelector('#stations');
  const employeeLayer = document.querySelector('#employees');
  const notice = document.querySelector('#notice');
  const empty = document.querySelector('#empty');
  document.querySelector('#empty-title').textContent = STRINGS.empty;
  document.querySelector('#empty-hint').textContent = STRINGS.emptyHint;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let port;
  let serial = 0;
  const pending = new Map();
  /** The stream position: events from an older epoch or revision are dropped. */
  let epoch = null;
  let revision = 0;
  let employees = [];
  /** The last layout: desks, sofas and queue places continue from it. */
  let layout;
  let roomKey = '';
  /** Employee id -> its DOM parts and the spot it was last drawn at. */
  const drawn = new Map();
  /** Employees on the way between spots, with their fallback arrival timers. */
  const walking = new Map();

  function sprite(sheet, rect, left, top, zIndex) {
    const el = document.createElement('div');
    el.className = 'sprite';
    el.setAttribute('aria-hidden', 'true');
    placeSprite(el, sheet, rect, left, top, zIndex);
    return el;
  }

  function placeSprite(el, sheet, rect, left, top, zIndex) {
    el.style.left = `${left * SCALE}px`;
    el.style.top = `${top * SCALE}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    el.style.zIndex = String(zIndex);
    el.style.backgroundImage = `url(${SHEETS[sheet]})`;
    el.style.backgroundPosition = `-${rect.x}px -${rect.y}px`;
  }

  function characterFrame(look, pose) {
    const col = POSES.indexOf(pose);
    const row = LOOKS.indexOf(look);
    return { x: col * FRAME.w, y: row * FRAME.h, w: FRAME.w, h: FRAME.h };
  }

  /** Claude Code and Codex employees get one of the looks, stably per surface; other agents the hooded one. */
  function lookFor(employee) {
    if (!/claude|codex/i.test(employee.agent)) return genericLook;
    const own = LOOKS.filter((id) => id !== genericLook);
    return own[employee.look % own.length];
  }

  /** Floor, walls, decor and the boss desk: redrawn only when the room changes size. */
  function drawRoom() {
    const key = `${layout.width}x${layout.height}:${layout.props.length}`;
    if (key === roomKey) return;
    roomKey = key;
    room.style.width = `${layout.width * SCALE}px`;
    room.style.height = `${layout.height * SCALE}px`;
    const parts = layout.props.map((p) => {
      const rect = FURNITURE[p.key];
      return sprite('furniture', rect, p.x - rect.anchorX, p.y - rect.anchorY, p.zIndex);
    });
    const { x, y, z } = layout.boss;
    const left = x - BOSS.deskX;
    const top = y - BOSS.deskY;
    parts.push(sprite('furniture', FURNITURE.bossDesk, left, top, stackIndex(z, 0)));
    const boss = sprite('characters', BOSS, left, top, stackIndex(z, 1));
    boss.setAttribute('role', 'img');
    boss.removeAttribute('aria-hidden');
    boss.setAttribute('aria-label', STRINGS.bossLabel);
    parts.push(boss);
    // Above the boss's head: the queue stands in front of the desk, so its bubbles never cover it.
    const plate = document.createElement('span');
    plate.className = 'tag plate';
    plate.setAttribute('aria-hidden', 'true');
    plate.textContent = STRINGS.bossPlate;
    plate.style.left = `${(x + BOSS.seatX - BOSS.deskX) * SCALE}px`;
    plate.style.top = `${(y + BOSS.seatY - BOSS.deskY - BOSS_PLATE_RISE) * SCALE}px`;
    plate.style.zIndex = String(LABEL_Z);
    parts.push(plate);
    roomLayer.replaceChildren(...parts);
  }

  /**
   * A desk is `working` while its employee sits at it (the seated frame
   * brings the chair), `reserved` while its employee queues or walks (monitor
   * on, chair empty), and `empty` while its employee rests or there is none.
   */
  function drawStations() {
    const deskState = new Map();
    for (const e of employees) {
      const desk = layout.deskFor[e.id];
      if (desk === undefined) continue;
      deskState.set(desk, e.state === 'resting' ? 'empty' : e.state === 'working' && !walking.has(e.id) ? 'working' : 'reserved');
    }
    const parts = [];
    layout.desks.forEach((seat, i) => {
      const state = deskState.get(i) || 'empty';
      const left = seat.x - STATION.deskX;
      const top = seat.y - STATION.deskY;
      parts.push(sprite('furniture', FURNITURE.desk, left, top, stackIndex(seat.z, 0)));
      parts.push(sprite('furniture', state === 'empty' ? FURNITURE.monitorOff : FURNITURE.monitorOn, left, top, stackIndex(seat.z, 1)));
      if (state !== 'working') parts.push(sprite('furniture', FURNITURE.chair, left, top, stackIndex(seat.z, 2)));
    });
    stationLayer.replaceChildren(...parts);
  }

  /** Frame top-left: a desk frame shares the station's origin; elsewhere the character's anchor stands on the seat. */
  function frameOrigin(seat) {
    return seat.spot === 'desk'
      ? { left: seat.x - STATION.deskX, top: seat.y - STATION.deskY }
      : { left: seat.x - STATION.seatX, top: seat.y - STATION.seatY };
  }

  /** Two neighbouring frames in one sheet row animate by stepping background-position-x. */
  function loop(el, look, first, seconds, phase) {
    const a = characterFrame(look, first);
    el.classList.add('loop');
    el.style.setProperty('--frame-from', `-${a.x}px`);
    el.style.setProperty('--frame-to', `-${a.x + 2 * a.w}px`);
    el.style.setProperty('--frame-time', `${seconds}s`);
    el.style.animationDelay = `-${(phase % 8) * (seconds / 8)}s`;
  }

  function createEmployee(e) {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'employee';
    const body = document.createElement('span');
    body.className = 'sprite';
    body.setAttribute('aria-hidden', 'true');
    const hit = document.createElement('span');
    hit.className = 'hit';
    hit.setAttribute('aria-hidden', 'true');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    const agent = document.createElement('span');
    agent.className = 'agent';
    tag.append(name, agent);
    const bubble = document.createElement('span');
    bubble.setAttribute('aria-hidden', 'true');
    root.append(body, hit, tag, bubble);
    root.addEventListener('click', () => focusPane(e.id));
    root.addEventListener('transitionend', (event) => { if (event.target === root) arrive(e.id); });
    const parts = { root, body, hit, tag, name, agent, bubble, spotKey: undefined };
    drawn.set(e.id, parts);
    employeeLayer.append(root);
    return parts;
  }

  function arrive(id) {
    if (!walking.has(id)) return;
    clearTimeout(walking.get(id));
    walking.delete(id);
    if (layout) draw();
  }

  function drawEmployee(e) {
    const spot = spotFor(e, layout);
    let parts = drawn.get(e.id);
    if (!spot) { if (parts) parts.root.hidden = true; return; }
    const fresh = !parts;
    if (!parts) parts = createEmployee(e);
    const { root, body, hit, tag, name, agent, bubble } = parts;
    root.hidden = false;
    // Only a change of spot is a walk; a room that grows moves everyone at once.
    if (!fresh && parts.spotKey !== spot.key && !reducedMotion.matches) {
      clearTimeout(walking.get(e.id));
      walking.set(e.id, setTimeout(() => arrive(e.id), WALK_MS + 100));
    }
    parts.spotKey = spot.key;
    const isWalking = walking.has(e.id);
    root.toggleAttribute('data-walking', isWalking);
    const { left, top } = frameOrigin(spot.seat);
    root.style.left = `${left * SCALE}px`;
    root.style.top = `${top * SCALE}px`;
    root.style.width = `${STATION.w * SCALE}px`;
    root.style.height = `${STATION.h * SCALE}px`;
    root.dataset.state = e.state;
    root.dataset.spot = spot.kind;
    root.disabled = e.stashed;
    root.setAttribute('aria-label', STRINGS.employee(e, STRINGS.state[e.state]));

    const look = lookFor(e);
    let pose;
    body.classList.remove('loop');
    body.style.animationDelay = '';
    if (isWalking) pose = 'walk1';
    else if (e.state === 'working') pose = 'type1';
    else if (e.state === 'needsYou') pose = 'standRaise'; // in the boss queue, hand up
    else if (e.state === 'finished') pose = 'walk1'; // in the boss queue, facing the viewer to report
    else pose = 'rest1';
    const z = stackIndex(spot.seat.z, 2);
    placeSprite(body, 'characters', characterFrame(look, pose), 0, 0, z);
    if (isWalking) loop(body, look, 'walk1', 0.4, e.look);
    else if (e.state === 'working') loop(body, look, 'type1', 0.5, e.look);
    else if (e.state === 'resting') loop(body, look, 'rest1', 2.4, e.look);
    hit.style.zIndex = String(z);

    tag.style.left = `${STATION.seatX * SCALE}px`;
    tag.style.top = `${(STATION.seatY + 2) * SCALE}px`;
    tag.style.zIndex = String(LABEL_Z);
    name.textContent = e.label;
    agent.textContent = ` · ${e.agent}`;

    const status = e.state === 'needsYou' ? 'alert' : e.state === 'finished' ? 'done' : '';
    bubble.hidden = !status;
    if (status) {
      bubble.className = `bubble ${status}`;
      bubble.style.left = `${STATION.seatX * SCALE}px`;
      bubble.style.zIndex = String(STATUS_BUBBLE_Z + Math.round(spot.seat.z));
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = status === 'alert' ? '!' : '✓';
      bubble.replaceChildren(mark, status === 'alert' ? STRINGS.needsYou : STRINGS.done);
    }
  }

  function draw() {
    drawRoom();
    for (const e of employees) drawEmployee(e);
    drawStations();
  }

  function forgetEmployees() {
    for (const timer of walking.values()) clearTimeout(timer);
    walking.clear();
    drawn.clear();
    employeeLayer.replaceChildren();
  }

  function show(snapshot) {
    employees = employeesFromSnapshot(snapshot);
    layout = layoutOffice(employees, layout);
    const present = new Set(employees.map((e) => e.id));
    for (const [id, parts] of drawn) {
      if (present.has(id)) continue;
      clearTimeout(walking.get(id));
      walking.delete(id);
      parts.root.remove();
      drawn.delete(id);
    }
    draw();
    room.setAttribute('aria-label', STRINGS.room(employees.length));
    empty.hidden = employees.length > 0;
    notice.textContent = snapshot.truncated ? STRINGS.truncated : '';
    notice.hidden = !snapshot.truncated;
  }

  /** Reset and unavailable carry no snapshot: drop everything, including the remembered layout. */
  function clear(message) {
    forgetEmployees();
    employees = [];
    layout = layoutOffice([]);
    draw();
    room.setAttribute('aria-label', STRINGS.room(0));
    empty.hidden = true;
    notice.textContent = message;
    notice.hidden = false;
  }

  function focusPane(employeeId) {
    const e = employees.find((x) => x.id === employeeId);
    const parts = drawn.get(employeeId);
    if (!e || !parts || !port || e.stashed) return;
    const id = String(++serial);
    parts.root.disabled = true;
    pending.set(id, employeeId);
    port.postMessage({ v: 1, id, kind: 'request', method: 'pane.focus', params: { id: e.paneId } });
  }

  function onAgentState(data) {
    if (typeof data.epoch !== 'string' || typeof data.revision !== 'number') return;
    if (data.epoch === epoch && data.revision <= revision) return;
    epoch = data.epoch;
    revision = data.revision;
    if (data.status === 'ready' && data.snapshot) show(data.snapshot);
    else clear(data.status === 'reset' ? STRINGS.loading : STRINGS.unavailable);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.v !== 1 || event.data?.kind !== 'init' || !event.ports[0]) return;
    // A fresh port is a fresh stream: nothing from the old one carries over.
    if (port) port.close();
    pending.clear();
    epoch = null;
    revision = 0;
    layout = undefined;
    clear(STRINGS.connecting);
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.v !== 1) return;
      if (data.kind === 'agent-state') onAgentState(data);
      else if (data.kind === 'response' && pending.has(data.id)) {
        const employeeId = pending.get(data.id);
        pending.delete(data.id);
        const e = employees.find((x) => x.id === employeeId);
        const parts = drawn.get(employeeId);
        if (parts) parts.root.disabled = Boolean(e && e.stashed);
        if (data.error || data.result?.error) {
          notice.textContent = STRINGS.focusFailed;
          notice.hidden = false;
        }
      }
    };
    port.start();
  });

  layout = layoutOffice([]);
  draw();
  notice.textContent = STRINGS.connecting;
})();
