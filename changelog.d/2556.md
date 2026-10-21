### Fixed

- **With many workspaces open, background refreshes no longer briefly fail other terminal reads.** The sidebar's missions refresh and the task ledger's periodic check used to ask the background service once per workspace. With about 100 workspaces the two together sometimes went over the service's per-second limit, so another read that landed in the same second, such as the terminal list, was refused. Each refresh is now one request for every workspace. (#2372)
