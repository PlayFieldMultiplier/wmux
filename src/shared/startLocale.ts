// The UI language a new window starts in. The renderer ships only the English
// table and loads its window's language before the first render, so main
// passes the language saved in session.json along with the window, the same
// way as the start polarity (windowStartPaint.ts). The renderer checks the
// value against the locales it has (i18n `resolveStartLocale`).

const ARG_PREFIX = '--wmux-start-locale=';

// A locale id, eg. `ko` or `pt-BR`. Anything else is not passed on.
const LOCALE_ID = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** The renderer arguments (`webPreferences.additionalArguments`) carrying the saved locale; none when there is none. */
export function startLocaleArgs(persisted: unknown): string[] {
  return typeof persisted === 'string' && LOCALE_ID.test(persisted) ? [`${ARG_PREFIX}${persisted}`] : [];
}

/** The locale main passed, from the preload's `process.argv`; null when there is none. */
export function startLocaleFromArgv(argv: readonly string[] | undefined): string | null {
  const arg = argv?.find((a) => a.startsWith(ARG_PREFIX));
  return arg ? arg.slice(ARG_PREFIX.length) : null;
}
