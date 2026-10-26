### Fixed

- **The coordinator no longer starts a second fix for an issue already being
  worked on.** When the owner asked the coordinator to handle an issue that
  another bot had already opened a pull request for, the coordinator saw only
  that the issue was still open and dispatched a developer, who opened a
  duplicate pull request. Reading one issue now also returns the work already
  under way on it: the open pull requests that close it, the open tasks on it
  or on those pull requests, and the latest bot cards in its thread. The
  coordinator reports that work, or sends the next step to the bot that owns
  it, instead of starting new work. Reading a pull request also lists the open
  tasks on it. On GitLab, linked merge requests are not read yet.
