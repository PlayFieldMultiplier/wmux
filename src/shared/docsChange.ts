// ─── Docs-only changes — a change no repository gate grades ─────────────────
//
// A pull request whose every changed path is documentation or content (text,
// markup, images) is reviewed by reading it: running a repository's install
// and test suite on it proves nothing about it. One definition, used by the
// reviewer's prompt, by main when it records a reading-only verdict
// (verify.rpc) and by the merge lane when it counts one (moaMergeLane.ts), so
// all three agree on what "docs-only" means.

/** File extensions that are documentation or content. */
export const DOCS_EXTENSIONS: readonly string[] = [
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc',
  '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.bmp',
];

/** Top-level folders whose every file is documentation. */
export const DOCS_FOLDERS: readonly string[] = ['docs', 'doc'];

/** Whether one changed path (`/`-separated, relative to the repository root)
 *  is documentation or content. Pure. */
export function isDocsPath(file: string): boolean {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.split('/').some((s) => s === '..')) return false;
  if (DOCS_FOLDERS.includes(p.split('/')[0]) && p.includes('/')) return true;
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 && DOCS_EXTENSIONS.includes(base.slice(dot));
}

/** Whether a change is docs-only: a complete, non-empty list of changed
 *  paths that are all documentation or content. A truncated list is never
 *  docs-only (the unread paths may be code). Pure. */
export function isDocsOnlyChange(files: readonly string[], truncated: boolean): boolean {
  return !truncated && files.length > 0 && files.every(isDocsPath);
}

/** The rule in words, for prompts. */
export const DOCS_ONLY_RULE =
  `every changed file is documentation or content: ${DOCS_EXTENSIONS.map((e) => `*${e}`).join(', ')}, or anything under ${DOCS_FOLDERS.map((d) => `${d}/`).join(' or ')}`;
