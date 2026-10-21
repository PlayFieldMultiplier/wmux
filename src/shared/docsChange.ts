// ─── Docs-only changes — a change no repository gate grades ─────────────────
//
// A pull request whose every changed path is documentation or content (text,
// markup, images) is reviewed by reading it: running a repository's install
// and test suite on it proves nothing about it. One definition, used by the
// reviewer's prompt, by main when it records a reading-only verdict
// (verify.rpc) and by the merge lane when it counts one (moaMergeLane.ts), so
// all three agree on what "docs-only" means.

/** Text and raster image extensions: documentation or content anywhere. */
export const DOCS_EXTENSIONS: readonly string[] = [
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp',
];

/** Markup that is documentation only inside a docs folder: elsewhere an
 *  .html or .svg file can be the app itself (a page with its own script). */
export const DOCS_FOLDER_EXTENSIONS: readonly string[] = ['.html', '.htm', '.svg', '.css'];

/** Top-level documentation folders. */
export const DOCS_FOLDERS: readonly string[] = ['docs', 'doc'];

/** Whether one changed path (`/`-separated, relative to the repository root)
 *  is documentation or content. A docs folder holds only the docs
 *  extensions: a script or config there (docs/conf.py) is code. Pure. */
export function isDocsPath(file: string): boolean {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '')) return false;
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot);
  if (DOCS_EXTENSIONS.includes(ext)) return true;
  return p.includes('/') && DOCS_FOLDERS.includes(p.split('/')[0].toLowerCase()) && DOCS_FOLDER_EXTENSIONS.includes(ext);
}

/** Whether a change is docs-only: a complete, non-empty list of changed
 *  paths that are all documentation or content. A truncated list is never
 *  docs-only (the unread paths may be code). Pure. */
export function isDocsOnlyChange(files: readonly string[], truncated: boolean): boolean {
  return !truncated && files.length > 0 && files.every(isDocsPath);
}

/** The rule in words, for prompts. */
export const DOCS_ONLY_RULE =
  `every changed file is documentation or content: ${DOCS_EXTENSIONS.map((e) => `*${e}`).join(', ')}, or ${DOCS_FOLDER_EXTENSIONS.map((e) => `*${e}`).join(', ')} under ${DOCS_FOLDERS.map((d) => `${d}/`).join(' or ')}`;
