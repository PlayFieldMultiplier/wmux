### Fixed

- **Fleet completion checks reflect the latest delegated job.** A newer working, failed or canceled task no longer leaves an older success badge on the agent. Completed jobs without evidence explicitly say that no verification was reported. Failed checks take precedence over passed checks; partially verified work stays neutral, and only a fully verified set gets a green check. English and Korean labels and tooltips identify the checks as agent reports and include failed commands.
