### Fixed

- **`wmux codex` on Windows says why it could not start.** When it refused to start, for example because `CODEX_HOME` named another Codex account than the terminal's, or the app was not running, it exited without a word. The reason now appears in the terminal, and paths with non-English characters show correctly in any console code page.
