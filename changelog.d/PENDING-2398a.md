### Fixed

- **A restored workspace you have not opened no longer starts its shells at
  launch.** On a cold start with many restored workspaces, every blank pane of
  every workspace started a shell at once, visible or not, which could run the
  machine out of memory. A hidden workspace's blank pane now says "Starts when
  opened" and starts its shell the first time you open it. A pane that
  replaces a Claude Code or Codex session with "resume on start" turned on
  still starts at launch. A session restored suspended (a plain WSL shell, or
  one past the restore limit) in a workspace you have not opened likewise
  starts when its pane is first shown. Agents see such a pane as not started
  (not as ended): reading it starts nothing, a message to it is stored for the
  receiver to poll, and typing into it with `terminal_send` starts it first.
