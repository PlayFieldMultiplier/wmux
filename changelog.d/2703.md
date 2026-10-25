### Fixed

- **Stopping an agent on Windows no longer touches an unrelated older
  process.** When a factory worker's agent was stopped, or a pane's agent was
  stopped from the session, wmux ended the agent and every process it found
  below it. Windows keeps a dead parent's process id on its children, and a new
  agent can be given that same id, so a program started long before the agent
  could be read as one of its children and ended with it. wmux now also checks
  each process's start time: only a process started after its parent counts as
  below the agent. A process whose start time cannot be read is left running,
  and the stop then reports that something is still running instead of
  claiming success.
