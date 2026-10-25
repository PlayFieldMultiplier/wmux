### Fixed

- **Bots ask for a workspace's repository once.** After you opened a
  workspace on a folder, adding bots could ask for the repository again, and
  then again in each bot's profile. wmux now remembers each workspace's
  repository, or that you chose none, and later bots and teams there use it
  without asking. The suggestion starts from the folder you opened the
  workspace on, and reads a WSL pane's folder correctly. When the folder
  cannot be used, for example because it has no origin remote, the add form
  says why and how to fix it. Add, Add team and Start wait until the folder
  is checked, so a bot is no longer made without the workspace's repository.
  When a workspace gets a repository, from an added bot, a team, the first
  run or one bot's profile, its other bots that had none take it too.
