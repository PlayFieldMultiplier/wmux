# Settings

Settings is a full rail page (not a modal) with a searchable nav of 15 tabs grouped as general, Agents and Connections. UI preferences (theme, language, font size, scrollback, sidebar options) apply immediately and are saved to the profile's `session.json`.

## Sub-features

- `settings-open` / `settings-close`: open from the More menu or ⌘,; close with "Close" or Escape (⌘, toggles).
- `settings-nav`: tabs General, Appearance, Terminal, Keyboard, Notifications, Claude Code, Accounts, Moa, Roles & fan-out, Token usage, Browser, Computer use, Remote & phone, LAN, About.
- `settings-search`: "Search settings" with grouped results and an empty state.
- `settings-theme`: Appearance › Theme radio cards (Tint, Paper, Mono, …).
- `settings-language`: General › Language select (`en`, `ko`, `ja`, …).
- `settings-persist`: values survive in `<userData>/session.json`.

## How to get to it (user POV)

- Rail "More" button › "Settings ⌘," ("Settings Ctrl+," on Windows/Linux).
- Shortcut ⌘, (Ctrl+,), which toggles.
- Other features link into tabs (More › "Turn on Moa…" opens the Moa tab).

## Driving it with control-wmux

Preconditions:

- Baseline state (wizard dismissed, Settings closed).

- **Open via menu.** Run `control-wmux click --label More`, then `control-wmux click --role menuitem --name "Settings ⌘,"`, then `control-wmux wait-settle --testid settings-page-title`. `control-wmux snapshot --as settings` shows `heading "Settings"`, `navigation "Settings"` and `heading "General"`.
- **Read a value.** Run `control-wmux inspect --js "({ page: document.querySelector('[data-testid=settings-page-title]')?.textContent, language: document.querySelector('select[aria-label=Language]')?.value, autoUpdate: document.querySelector('[role=switch][aria-label=Auto-update]')?.getAttribute('aria-checked') })"`. Returns `{page: "General", language: "en", autoUpdate: "true"}` on a fresh profile.
- **Close / reopen by keyboard.** `control-wmux press --key Escape`, then `control-wmux wait-settle --testid settings-page-title --state hidden`; `control-wmux press --key Meta+Comma` reopens it.
- **Switch tab.** Run `control-wmux click --selector '[data-settings-tab="appearance"]'`. The tab gets `aria-current="page"` and the title reads "Appearance".
- **Change theme.** Run `control-wmux click --role radio --name Paper`. `control-wmux inspect --js "document.documentElement.dataset.theme"` returns `"paper"` immediately.
- **Persistence (second view).** The UI autosaves every 5 s, so poll the profile file with a bound instead of sleeping; this prints `paper` (anything else after 15 s is NOT VERIFIED):

  ```sh
  python3 - <suffix> <<'PY'
  import json, os, sys, time
  f = os.path.expanduser(f"~/Library/Application Support/wmux{sys.argv[1]}/session.json")
  end, theme = time.time() + 15, None
  while time.time() < end:
      theme = json.load(open(f)).get("theme")
      if theme == "paper":
          break
      time.sleep(0.5)
  print(theme)
  PY
  ```

  Restore with `control-wmux click --role radio --name Tint`.
- **Search.** Run `control-wmux click --testid settings-search`, `control-wmux type --text theme --testid settings-search`. `control-wmux wait-settle --testid settings-search-results` passes. `type` appends, so clear first (`control-wmux press --key Meta+a --testid settings-search`, `press --key Backspace`); a nonsense query such as `zzzqqq` shows `settings-search-empty` ("No settings match “zzzqqq”.").
- **Proof.** `control-wmux screenshot --as settings-general` shows the Settings page with the General tab.

## Gotchas

- ⌘, toggles: pressing it with Settings open closes it.
- While a search query is present no tab is `aria-current` and the page title is replaced by results; clicking a tab clears the search.
- All labels are translated. After switching Language, English names stop matching; use `data-settings-tab` and test ids. Switch back to English before the next recipe.
- The font-size slider is on Appearance, not Terminal.
- Settings that write outside the profile: Claude Code tab installers (hooks, statusline), Accounts (CLI logins), Remote & phone and LAN pairing, Computer use permissions. Read them, do not toggle them.
- On macOS the General tab still shows "Start on Windows startup" (observed in 4.3.0); report it as a product observation, not drift.
- `~/.wmux<suffix>/config.json` is daemon config; the Settings UI does not write UI preferences there.
