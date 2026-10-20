### Changed

- **After a crash, programs started from a terminal close with it (Windows).** With the default Node terminal engine, if the background service crashes or is force-closed, the shells it ran and anything started from them now end with it instead of staying behind unseen and holding memory; a normal quit or an update leaves programs you started on purpose (for example with `start`) running, as before. (#2398)
