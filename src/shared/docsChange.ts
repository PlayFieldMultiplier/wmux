// ─── Docs-only changes — what a verify worker reads instead of testing ──────
//
// A verify worker on a pull request whose every changed path is
// documentation or content (text, markup, images) reads it and runs no test
// suite of its own (worktask/botFanoutPresets.ts VERIFY_PROMPT). The
// repository's gate still runs on it: a docs file can be what a gate checks
// (a generated reference a drift guard compares, a fixture a test reads), so
// docs-only never waives a gate. Only a repository that declares no gate is
// graded on reading alone (TaskGateRunner.baseGate, verify.rpc).

/** Extensions that are documentation or content anywhere. */
export const DOCS_EXTENSIONS: readonly string[] = [
  '.md', '.markdown', '.rst', '.adoc',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp',
];

/** Extensions that are documentation only inside a docs folder: elsewhere a
 *  .txt file can be a build or dependency list (CMakeLists.txt,
 *  requirements.txt) and an .html or .svg file the app itself. */
export const DOCS_FOLDER_EXTENSIONS: readonly string[] = ['.txt', '.html', '.htm', '.svg', '.css'];

/** Top-level documentation folders. */
export const DOCS_FOLDERS: readonly string[] = ['docs', 'doc'];

/** File names that are documentation anywhere: LICENSE, NOTICE, LICENSE-MIT,
 *  each bare or as .md, .txt or .rst. */
const DOCS_NAMES = /^(?:license|notice)(?:-[a-z0-9]+)?(?:\.(?:md|txt|rst))?$/;

/** Whether one changed path (`/`-separated, relative to the repository root)
 *  is documentation or content. A docs folder holds only the docs
 *  extensions: a script or config there (docs/conf.py) is code. Pure. */
export function isDocsPath(file: string): boolean {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '')) return false;
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  if (DOCS_NAMES.test(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot);
  if (DOCS_EXTENSIONS.includes(ext)) return true;
  return p.includes('/') && DOCS_FOLDERS.includes(p.split('/')[0].toLowerCase()) && DOCS_FOLDER_EXTENSIONS.includes(ext);
}

/** The rule in words, for prompts. */
export const DOCS_ONLY_RULE =
  `every changed file is documentation or content: ${DOCS_EXTENSIONS.map((e) => `*${e}`).join(', ')}, LICENSE* and NOTICE*, or ${DOCS_FOLDER_EXTENSIONS.map((e) => `*${e}`).join(', ')} under ${DOCS_FOLDERS.map((d) => `${d}/`).join(' or ')}`;
