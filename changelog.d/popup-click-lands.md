### Fixed

- **Clicking a link that opens a new tab no longer times out on macOS, or opens
  the tab twice.** When a click opened a popup as the active tab, Chrome on
  macOS stopped drawing the page behind it, so browser_click waited for that
  page until its action timeout, reported a failure, and then clicked the
  element a second time. browser_click now treats the popup as proof the click
  landed and returns right away, and never presses the element again after it
  has opened its popup.
