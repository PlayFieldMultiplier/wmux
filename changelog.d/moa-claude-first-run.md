### Fixed

- **Moa explains Claude Code's first-time setup in plain words.** The first
  time Claude Code runs, it asks you to pick a look and sign in. When Moa hit
  that screen, the chat showed the raw terminal text ("Dark mode / Light mode
  ... Syntax theme") next to "Not sent", with no hint of what to do. Moa now
  says that Claude Code needs a one-time setup and lists the three steps:
  open the setup, answer Claude's questions, then press Retry.
- **Moa explains Claude's "trust this folder?" question.** Claude Code asks
  whether to trust a folder before it works there, with "No, exit" chosen by
  default. Moa used to show that as raw terminal text. It now explains what
  trusting means (Claude can read, change and run files there), tells you how
  to answer, and leaves the choice to you; wmux never answers it for you. The
  setup cards are also left-aligned now instead of right-aligned.
