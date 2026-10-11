### Fixed

- **A2A host identity no longer fails to start on Windows when several wmux processes start at once.** The certificate issue lock is a file that one process creates and deletes. On Windows, a file another process is still reading stays "delete pending" for a moment, and creating or opening it in that window fails with EPERM. The process that hit this crashed instead of waiting its turn. It now treats that state as "the lock is changing hands" and keeps waiting, within the same time limit as before.
