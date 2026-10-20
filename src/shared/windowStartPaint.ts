// What a new window paints before the renderer has applied the saved theme
// (#2512). Main builds the native window background and the Windows overlay
// strip from it; the preload paints the page with it until `data-theme` is set.
// The renderer then shows the polarity's default theme until the session's
// own theme loads. All three follow the polarity the renderer last saved
// (`windowAppearance` in session.json), so a light theme does not start dark.
//
// The colours are the default dark (Tint) and light (Paper) themes' frame and
// secondary text, the pair the renderer sends for the overlay once it loads
// (themeParity.test.ts keeps them equal to the themes).

export type StartPolarity = 'dark' | 'light';

export const WINDOW_START_COLORS: Record<StartPolarity, { background: string; symbol: string }> = {
  dark: { background: '#121015', symbol: '#C2BDC9' },
  light: { background: '#ECECEF', symbol: '#3F3F48' },
};

/** The theme the renderer shows until the session's own theme loads: the polarity's default. */
export const WINDOW_START_THEME: Record<StartPolarity, string> = { dark: 'tint', light: 'paper' };

/** The saved polarity, whitelisted: anything but 'light' starts dark, the default theme's. */
export function startPolarity(persisted: unknown): StartPolarity {
  return persisted === 'light' ? 'light' : 'dark';
}

const ARG_PREFIX = '--wmux-start-polarity=';

/** The renderer argument (`webPreferences.additionalArguments`) carrying the polarity to the preload. */
export function startPolarityArg(polarity: StartPolarity): string {
  return `${ARG_PREFIX}${polarity}`;
}

/** The polarity main passed, from the preload's `process.argv`; null when there is none. */
export function startPolarityFromArgv(argv: readonly string[] | undefined): StartPolarity | null {
  const arg = argv?.find((a) => a.startsWith(ARG_PREFIX));
  if (!arg) return null;
  return asPolarity(arg.slice(ARG_PREFIX.length));
}

/**
 * The page's sessionStorage key for the polarity of the theme on screen. The
 * renderer writes it whenever the theme's polarity is read; it outlives a
 * reload and a renderer crash but not the window, so a reload starts in the
 * theme the user has now rather than the one the window was built with.
 */
export const START_POLARITY_STORAGE_KEY = 'wmux:start-polarity';

/** A reload's polarity (sessionStorage) over the window's (argv); null when neither is known. */
export function resolveStartPolarity(stored: string | null | undefined, argv: readonly string[] | undefined): StartPolarity | null {
  return asPolarity(stored) ?? startPolarityFromArgv(argv);
}

function asPolarity(value: unknown): StartPolarity | null {
  return value === 'dark' || value === 'light' ? value : null;
}

/**
 * The page's first paint, before any script runs: the stylesheet's `:root`
 * block is the dark default, and `index.tsx` sets `data-theme` only once the
 * bundle runs. Until then the page takes the window's start colour, so the
 * first frame matches the native background. Matched only without
 * `data-theme`, so it never touches a theme.
 */
export function startPaintCss(polarity: StartPolarity): string {
  return `:root:not([data-theme]) { --bg-base: ${WINDOW_START_COLORS[polarity].background}; }`;
}
