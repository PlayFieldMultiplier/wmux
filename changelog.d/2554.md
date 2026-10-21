### Fixed

- Windows updates keep autostart and the Desktop shortcut the way you left them. Every update used to turn autostart back on and recreate a Desktop shortcut you had deleted.
- A stalled or dropped update check no longer stops later checks. Before, one dropped connection meant wmux stopped looking for updates until it was restarted.
- When a published update fails verification, Settings › Updates says so, and wmux waits for the release to change instead of downloading the same installer again every 30 minutes.
