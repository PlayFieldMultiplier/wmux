# Browser panel

A pane can hold browser tabs next to its terminals. The built-in browser is an Electron `<webview>` with a toolbar (Back, Forward, Reload, URL field, Inspector, DevTools, Close) and a title strip; agents drive it through wmux's MCP browser tools, users through the same toolbar.

## Sub-features

- `br-new-tab`: "New browser" adds a browser tab to the same pane (opens `https://google.com`).
- `br-new-split`: ⇧⌘L opens a browser in a new split; ⇧⌘N (Ctrl+Shift+N) a private tab.
- `br-nav`: URL field, Back, Forward, Reload; ⌘L focuses the URL field.
- `br-title`: the strip above the page shows the page title; the tab label stays "Browser".
- `br-close`: toolbar "Close" or the tab ✕ removes the tab and its webview.
- `br-devtools` / `br-inspector`: F12 / "Open DevTools (F12)"; the Inspector toggle.

## How to get to it (user POV)

- Pane header button "New browser" (in the "Pane actions" ⋮ menu on narrow panes).
- Shortcuts ⇧⌘L (browser in a new split), ⇧⌘N (private tab).
- Palette "Open Browser", "Open Private Browser Tab".

## Driving it with control-wmux

Preconditions:

- Baseline state on the Workspaces page; network access to google.com (the default page).
- Settings › Browser backend is the default built-in one (the other backends open the real system browser or Chrome).

- **Open.** Run `control-wmux click --selector '[data-pane-action="new-browser"]'`, then `control-wmux wait-settle --selector webview --timeout 15000`. `control-wmux inspect --js "[...document.querySelectorAll('.wmux-surface-tab')].map(t => t.textContent)"` lists a `Browser` tab.
- **Read URL and title from the main window (second view).** Run `control-wmux inspect --js "[...document.querySelectorAll('webview')].map(w => ({ url: w.getURL(), title: w.getTitle() }))"`. Returns `{url: "https://www.google.com/", title: "Google"}`.
- **Toolbar.** `control-wmux snapshot --as browser` shows buttons "Back", "Forward", "Reload", the URL textbox with the current URL, "Open DevTools (F12)" and "Close".
- **Navigate.** Focus the URL field with `control-wmux press --key Meta+l` (only while the browser tab is active), then `control-wmux type --text 'http://127.0.0.1:<port>/'` for a local page you serve, then `control-wmux press --key Enter`. Re-run the read-back; `url` and `title` follow.
- **Close.** Run `control-wmux click --selector '[data-surface-tab-close]' --nth 1` and confirm with `control-wmux click --selector '[data-close-tab-confirm]'`. The `webview` count drops to 0.

## Gotchas

- Only http(s) URLs load; `about:`, `data:` and `file:` are dropped silently, and non-URL text becomes a Google search. For an offline proof, serve a page on `http://127.0.0.1:<port>` with a known `<title>`.
- Each webview is its own CDP target; the driver always attaches to the main window (`index.html`) and reads the webview through `getURL()` / `getTitle()` on the element.
- The URL field has no label or test id; it shows the current URL only while unfocused.
- "Reload" and "Close" names also exist on other panels; scope by pane or use `--nth`.
- The default partition keeps cookies across runs of the same profile; `stop --purge` discards them.
- Never bind "Live Chrome" (workspace context menu › Chrome profile): it attaches the owner's real Chrome.
- The browser-protection policy dialog (`browser-policy-*`) exists only with the Chrome backend.
