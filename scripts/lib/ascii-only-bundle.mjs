// Keeps every emitted JS chunk pure ASCII.
//
// V8 and Blink hold a script's source as a one-byte string only while every
// character in it fits in one byte; a single wider character (a `→` in a
// regex, a Korean UI string) stores the WHOLE source as UTF-16, doubling what
// each process keeps resident for it. The Vite configs set esbuild's
// `charset: 'ascii'`, which writes strings, templates and identifiers with
// `\uXXXX` escapes, but esbuild prints regular-expression literals as written.
// This plugin escapes those after minification, then fails the build if any
// emitted script still holds a non-ASCII character.

const NON_ASCII = /[\u0080-\uffff]/;

/**
 * A regex literal's source (`/…/flags`) with each non-ASCII UTF-16 code unit
 * written as `\uXXXX`. The match set is unchanged: without the u/v flag a regex
 * works on code units, and with it an escaped surrogate pair is read back as one
 * code point. An identity escape (`\→`, legal only without u/v) already means
 * the character itself, so its backslash is dropped rather than producing
 * `\\u2192` (a literal backslash).
 */
export function escapeRegexLiteral(raw) {
  let out = '';
  let backslashes = 0;
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    if (unit <= 0x7f) {
      out += raw[i];
      backslashes = raw[i] === '\\' ? backslashes + 1 : 0;
      continue;
    }
    if (backslashes % 2 === 1) out = out.slice(0, -1);
    out += `\\u${unit.toString(16).padStart(4, '0')}`;
    backslashes = 0;
  }
  return out;
}

/** `code` with every regex literal escaped; `ast` is its ESTree (UTF-16 offsets). */
export function escapeRegexLiterals(code, ast) {
  const spans = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && node.regex && NON_ASCII.test(code.slice(node.start, node.end))) {
      spans.push([node.start, node.end]);
      return;
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  let out = '';
  let from = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    const raw = code.slice(start, end);
    if (raw[0] !== '/') throw new Error(`ascii-only-bundle: regex literal offset mismatch at ${start}`);
    out += code.slice(from, start) + escapeRegexLiteral(raw);
    from = end;
  }
  return out + code.slice(from);
}

/** The first non-ASCII character in `code`, with a little context, or null. */
export function firstNonAscii(code) {
  const match = NON_ASCII.exec(code);
  if (!match) return null;
  const at = match.index;
  return { at, char: match[0], context: code.slice(Math.max(0, at - 40), at + 20) };
}

export function asciiOnlyBundle() {
  return {
    name: 'wmux-ascii-only-bundle',
    // `post` so it runs after Vite's esbuild minify. No shipped build emits
    // source maps; the escapes only lengthen a line, so a map would shift
    // columns after an escaped regex on that line.
    renderChunk: {
      order: 'post',
      handler(code) {
        if (!NON_ASCII.test(code)) return null;
        const out = escapeRegexLiterals(code, this.parse(code));
        return out === code ? null : { code: out, map: null };
      },
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!/\.[cm]?js$/.test(file.fileName)) continue;
        const code = file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8');
        const hit = firstNonAscii(code);
        if (hit) {
          this.error(
            `${file.fileName} holds a non-ASCII character (U+${hit.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) at ${hit.at}: ${JSON.stringify(hit.context)}. ` +
              'One such character makes V8 keep the whole script as UTF-16; write it as a \\u escape (see scripts/lib/ascii-only-bundle.mjs).',
          );
        }
      }
    },
  };
}
