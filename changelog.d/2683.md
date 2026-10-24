### Fixed

- **The `wmux` command's output on Windows is no longer garbled or lost.** On a console using a non-UTF-8 code page, such as 949 on a Korean system, non-English text printed by `wmux` came out garbled; it now shows correctly. Redirecting one stream also made the other one vanish: with `> file`, `| more` or `> nul`, error messages never reached the screen, and with `2> file` the normal output did not. Whatever is not redirected now reaches the terminal, and redirected output is written as before (#2672).
