### Changed

- **After a crash, programs started from a terminal close with it (Windows).** If the background service crashes or is force-closed, the shells it ran and anything started from them now end with it, instead of being left running unseen and holding memory. A normal quit or an update leaves programs you started on purpose (for example with `start`) running, as before. (#2398)
