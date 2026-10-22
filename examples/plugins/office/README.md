# Office rail page

A UI plugin that draws your agents as employees in an isometric pixel-art
office, one room per workspace. It uses only the rail-page API: `agent-state`
snapshots of every local workspace and `pane.focus`. It is a plain static
bundle with no build step and no runtime dependencies; the page, its scripts and its two
sprite sheets are all in this directory. The example follows the repository's
MIT license.

What the snapshot drives:

- One room per local workspace, in the sidebar's order, under the workspace's
  name; the workspace on screen is marked `current`. A workspace without
  agents is a one-line "No local agents", except the current one, which keeps
  its (empty) office. Remote PCs are not shown.
- One employee per pane surface that runs an agent. Its name tag is the pane's
  `label`; where two would read the same, the agent's name is added (hover or
  focus an employee to see the agent).
- `working`: at its own desk, typing.
- `needsYou`: walks to the queue in front of the boss desk and raises a hand,
  under a red "! Needs you" bubble.
- `finished`: joins the same queue, behind everyone who needs you, under a
  green "✓ Done" bubble.
- `resting`: on a sofa. The lounge adds sofas as more employees rest.
- Select an employee to focus its pane (`pane.focus`); the host switches to
  that employee's workspace when it is another one, then returns to
  Workspaces. Stashed panes are shown but not focusable, as in the Agent status
  example.

Everyone keeps their desk, sofa and place in the queue while the page is open
(each room remembers its own), and an employee walks only when its spot
changes. Walking and the typing and resting loops stop under the system's
reduced-motion setting. The iframe has an opaque origin and no storage, so
leaving the page forgets the seating, and the app's own reduced-motion
preference is not visible to it.

## Install

Copy this directory into `~/.wmux/plugins/office` (Windows:
`%USERPROFILE%\.wmux\plugins\office`), restart wmux, select **Office** in the
rail, and review the permission prompt. For an isolated test instance, use
that instance's suffixed `.wmux` directory instead. It is not in the curated
catalog. Manually installed copies can be disabled in Settings > Plugins;
their folders are not deleted there.

This requires a host implementing `ui.rail-page`, `agent.state.read` and
`agent.state.read.all`. Older hosts reject the manifest's unknown
capabilities.

If the host sends only the workspace it shows (a plain `snapshot` instead of
`allWorkspaces`, which is what a host does for a plugin that is not granted
`agent.state.read.all`), the page falls back to a single room for that
workspace, without a heading.

Permissions:

- `ui.rail-page`: mount this page in a sandboxed iframe when selected.
- `agent.state.read`: read local agent names, user pane labels and final Fleet
  state in the workspace currently bound by the host.
- `agent.state.read.all`: the same for every local workspace, plus each
  workspace's name. With `pane.read` it also lets a click take you to a pane in
  another workspace.
- `pane.read`: the existing pane listing and focus permission. This additionally
  permits pane metadata, including working directories; it is not status-only.

## Not yet, and what would enable it

The page asks for no terminal-content permission, so employees have no
activity bubbles. `agent.state({includeActivity:true})` could supply them, but
it needs unrestricted `terminal.read`, which also allows reading every
terminal's output; a narrower activity-only grant would let the Office show
what each agent is doing without that. Other gaps, discussed in
[openwong2kim/wmux#2485](https://github.com/openwong2kim/wmux/discussions/2485):

- "Needs you" carries no reason (a question, an error, a usage limit) and no
  usage-limit reset time.
- Agent Teams teammates are not drawn: the snapshot does not list them, and the
  page does not invent them.
- There is no "state since" stamp, so the queue orders people by when this page
  first saw them there, not by when they started waiting.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Name, permissions and the rail page. |
| `index.html` | Page markup and styles; loads the three scripts. |
| `office.js` | Bridge handling and drawing (one room per workspace: DOM sprites, names, bubbles). |
| `layout.js` | Pure layout: rooms per workspace, employees from a snapshot, desks, queue, sofas, room. |
| `sprites.js` | Sprite rectangles in the two sheets. |
| `characters.png`, `furniture.png` | The art. |

The art is original to this repository. It is drawn pixel by pixel by code
(`scripts/office-art/` in the [bluemas/wmux](https://github.com/bluemas/wmux)
fork, where it was made), not taken from any third-party source, and is
released with this example under the same MIT license. `sprites.js` mirrors
the layout data that generator writes with the sheets.

The host sends replacement snapshots through `kind: "agent-state"`, with
`allWorkspaces` (or, without that grant, `snapshot`). Reset and
unavailable messages clear the room, and events from an older epoch or
revision are ignored. All labels are rendered with `textContent`.
