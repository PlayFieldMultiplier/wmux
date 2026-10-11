# Terminal input and output

Each terminal tab is an xterm.js view of a real shell running in the wmux daemon. A user types commands, reads output, searches the scrollback (one pane or all panes), copies and pastes, and zooms the font.

## Sub-features

- `term-type`: keystrokes reach the shell of the focused pane.
- `term-read`: output appears in the pane (proved through search, see below).
- `term-find`: find bar with Regex and All Panes toggles, Previous/Next, cross-pane results list.
- `term-copy-paste`: ⌘C / ⌘V on macOS (Ctrl+C copies only with a selection on Windows/Linux), Ctrl+Shift+C/V everywhere; right-click Copy/Paste.
- `term-zoom`: font size 8 to 24 (default 14) with ⌘= / ⌘- / ⌘0.
- `term-scroll`: scroll up, then the "Scroll to bottom" button.

## How to get to it (user POV)

- Click a pane and type.
- ⌘F toggles the find bar (placeholder "Search..."); its "All Panes" toggle searches every pane.
- ⌘= / ⌘- / ⌘0 change the terminal font size; the value shows in Settings › Appearance › "Font size".
- There is no "clear" command; users type `clear`.

## Driving it with control-wmux

Preconditions:

- Baseline state; the pane shows a shell prompt.
- A scratch directory exists for recipes that need a cwd, for example `mkdir -p /tmp/wmux-verify-<run>` created by you.

- **Type and run.** Run `control-wmux type --text 'echo verify-marker-$((40+2))' --label "Terminal input"`, then `control-wmux press --key Enter --label "Terminal input"`, then `control-wmux wait-settle --quiet 800`.
- **Read the output back (second view).** Run `control-wmux inspect --js "window.__wmuxRunPaneSearch('verify-marker-42', false).then(r => r.results.map(x => ({ pane: x.paneLabel, text: x.text, before: x.contextBefore.at(-1) })))"`. One result with `text: "verify-marker-42"` and the typed `echo …$((40+2))` line just before it: the shell evaluated the arithmetic, so the command really ran.
- **Find bar (user path).** Run `control-wmux press --key Meta+f --label "Terminal input"`, `control-wmux click --text "All Panes"`, `control-wmux type --text verify-marker-42 --selector 'input[placeholder="Search..."]'`, `control-wmux press --key Enter --selector 'input[placeholder="Search..."]'`. `control-wmux snapshot --as find` shows `textbox "Search..."` and `button "All Panes" [pressed]`; `control-wmux inspect --js "[...document.querySelectorAll('[role=option]')].map(o => o.textContent)"` returns `["w1-1Line 2verify-marker-42"]` (pane label, line, match). Close with `control-wmux press --key Escape`.
- **Change directory for later recipes.** Run `control-wmux type --text 'cd /tmp/wmux-verify-<run>' --label "Terminal input"` and `control-wmux press --key Enter --label "Terminal input"`.
- **Font zoom.** Run `control-wmux press --key Meta+Equal --label "Terminal input"`; then in Settings › Appearance read `control-wmux inspect --js "document.querySelector('input[type=range][aria-label=\"Font size\"]')?.value"` = `15`. Restore with `Meta+Digit0`.

## Gotchas

- Terminal text is drawn by WebGL: `.xterm-rows` has no text, and the accessibility tree has only the "Terminal input" textbox. Read output through the search route above, never by scraping the DOM.
- `__wmuxRunPaneSearch` is the same search the find bar runs; use it only to read.
- Keys reach the shell only while the pane's textbox has focus: pass `--label "Terminal input"` to `type`/`press` (with several panes, add `--nth`).
- On macOS Ctrl+C is always SIGINT; ⌘C copies. Paste reads the system clipboard through the app, not the page clipboard.
- The prompt line contains the user and host name; keep evidence about your marker, not the prompt.
- Typing runs real commands on the real machine (shared HOME): only run harmless ones in scratch directories.
