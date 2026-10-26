// Keeps every emitted JS chunk a one-byte script source.
//
// V8 and Blink hold a script's source as a one-byte string only while every
// character in it is at most U+00FF; a single wider character (a `→` in a
// regex, a Korean UI string) stores the WHOLE source as UTF-16, doubling what
// each process keeps resident for it. The Vite configs set esbuild's
// `charset: 'ascii'`, which writes strings, templates and identifiers with
// `\uXXXX` escapes, but esbuild prints regular-expression literals and
// comments (all of them unminified, legal ones when minified) as written. This
// plugin escapes those after esbuild has run, then fails the build if any
// emitted script still holds a character above U+00FF.
//
// Not covered: pdf.js's own worker and data files, which the renderer config
// copies verbatim into `pdfjs/` (loaded only while a PDF preview is open).

const NON_ASCII = /[\u0080-\uffff]/;
const WIDE = /[\u0100-\uffff]/;
// Outside every token a character is whitespace or comment text.
const SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const LINE_TERMINATORS = new Set([0x2028, 0x2029]);

const escapeUnit = (unit) => `\\u${unit.toString(16).padStart(4, '0')}`;

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
    out += escapeUnit(unit);
    backslashes = 0;
  }
  return out;
}

/** [start, end, isRegex] for every leaf token that can hold non-ASCII text, in source order. */
function tokenSpans(ast) {
  const spans = [];
  // An explicit stack: minified code nests deeply enough to overflow recursion.
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!node || typeof node.type !== 'string') continue;
    switch (node.type) {
      case 'Literal':
        if (node.regex || typeof node.value === 'string') spans.push([node.start, node.end, Boolean(node.regex)]);
        continue;
      case 'TemplateElement':
      case 'Identifier':
      case 'PrivateIdentifier':
        spans.push([node.start, node.end, false]);
        continue;
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/**
 * `code` (whose ESTree is `ast`, UTF-16 offsets) with non-ASCII escaped where
 * that cannot change what runs: inside regex literals, and between tokens,
 * where it is comment text (escaped) or whitespace (a space or a newline).
 * Strings, templates and identifiers are left to esbuild's charset: a raw
 * character there is a tagged template's observable `raw` text, which no
 * rewrite keeps, so the guard reports it instead.
 */
export function escapeRegexesAndComments(code, ast) {
  const spans = tokenSpans(ast);
  let out = '';
  let from = 0;
  let next = 0;
  for (let i = 0; i < code.length; i++) {
    const unit = code.charCodeAt(i);
    if (unit <= 0x7f) continue;
    while (next < spans.length && spans[next][1] <= i) next++;
    const span = next < spans.length && spans[next][0] <= i ? spans[next] : null;
    if (span) {
      if (span[2]) {
        const raw = code.slice(span[0], span[1]);
        if (raw[0] !== '/') throw new Error(`ascii-only-bundle: regex literal offset mismatch at ${span[0]}`);
        out += code.slice(from, span[0]) + escapeRegexLiteral(raw);
        from = span[1];
        i = span[1] - 1;
      }
      continue;
    }
    out += code.slice(from, i) + (LINE_TERMINATORS.has(unit) ? '\n' : SPACE.test(code[i]) ? ' ' : escapeUnit(unit));
    from = i + 1;
  }
  return out + code.slice(from);
}

/** The first character above U+00FF in `code`, with a little context, or null. */
export function firstWideChar(code) {
  const match = WIDE.exec(code);
  if (!match) return null;
  const at = match.index;
  return { at, codePoint: code.codePointAt(at), context: code.slice(Math.max(0, at - 40), at + 20) };
}

export function asciiOnlyBundle() {
  return {
    name: 'wmux-ascii-only-bundle',
    // `post` so it runs after Vite's esbuild minify. No shipped build emits
    // source maps; the escapes only lengthen a line, so a map would shift
    // columns after an escape on that line.
    renderChunk: {
      order: 'post',
      handler(code) {
        if (!NON_ASCII.test(code)) return null;
        const out = escapeRegexesAndComments(code, this.parse(code));
        return out === code ? null : { code: out, map: null };
      },
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!/\.[cm]?js$/.test(file.fileName)) continue;
        // A worker script reaches the parent build as an asset.
        const code = file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8');
        const hit = firstWideChar(code);
        if (hit) {
          this.error(
            `${file.fileName} holds U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')} at ${hit.at}: ${JSON.stringify(hit.context)}. ` +
              'One character above U+00FF makes V8 keep the whole script as UTF-16; write it as a \\u escape (see scripts/lib/ascii-only-bundle.mjs).',
          );
        }
      }
    },
  };
}
