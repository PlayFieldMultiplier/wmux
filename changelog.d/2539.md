### Fixed

- **Much less memory per terminal on Windows.** Each open terminal used to keep its own helper thread of about 12 MB in the background service just to read its output; all terminals now share one. With 120 terminals open the service drops from about 1.3 GB to about 140 MB, which leaves more room before Windows runs out of memory on a large restore. (#2398)
