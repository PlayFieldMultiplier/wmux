# Agent state rail page

A small original UI plugin demonstrating a full rail page, workspace-scoped
agent snapshots, live updates and jumping to a pane. No external assets or
runtime dependencies are used. The example follows the repository's MIT license.

In Settings > Plugins > Discover, install **Agent status**, then review its
permissions from Installed. Installation does not approve permissions. You can
disable or uninstall the catalog copy there without restarting wmux.

For manual installation, copy this directory into `~/.wmux/plugins/agent-state-page` (Windows:
`%USERPROFILE%\.wmux\plugins\agent-state-page`), restart wmux, select **Agent
status** in the rail, and review the permission prompt. For an isolated test
instance, use that instance's suffixed `.wmux` directory instead.

This requires a host implementing `ui.rail-page` and `agent.state.read`.
Older hosts reject the manifest's unknown capabilities; this is not a plugin
for those versions. Manual file replacements are applied at app restart. Manually installed copies
can be disabled in Settings; their folders are not deleted by the catalog.

Permissions:

- `ui.rail-page`: mount this page in a sandboxed iframe when selected.
- `agent.state.read`: read local agent names, user pane labels and final Fleet
  state in the workspace currently bound by the host.
- `pane.read`: the existing pane listing and focus permission. This additionally
  permits pane metadata, including working directories; it is not status-only.

The example has no terminal-content permission. Activity text is opt-in for
other plugins through `agent.state({includeActivity:true})`, and requires both
`agent.state.read` and unrestricted `terminal.read`. Such activity can contain
command fragments, filenames and search terms.

Plain shell panes, Bots workspaces, and panes containing any remote terminal
are excluded. A mixed local/remote pane is excluded as a whole because its
canonical attention may belong to the remote tab. Stashed panes are shown but
the example does not automatically unstash them. Individual teammates are not
invented from a count or a freshness signal.

The host sends replacement snapshots through `kind: "agent-state"`. Reset and
unavailable messages clear the old view. Leaving the page closes its iframe and
subscription. The example renders every received label using `textContent`.

Windows verification: copy from a profile path with spaces and non-ASCII
characters; check trust approval, protocol loading, focus, keyboard navigation,
and cleanup after leaving. This example does not require a POSIX shell.
