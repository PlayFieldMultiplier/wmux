// Name filter for the file tree: walks the folder below the tree's root and
// keeps every entry whose name contains the query, with the folders leading
// to it. The tree itself loads lazily, so filtering only what is expanded
// would miss almost everything; the walk is what makes the filter useful.

export interface FilterEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FilterNode extends FilterEntry {
  children?: FilterNode[];
  isExpanded?: boolean;
  /** True on an entry whose own name matched (its ancestors are only context). */
  matched?: boolean;
}

export interface FilterResult {
  nodes: FilterNode[];
  matchCount: number;
  /** The walk stopped at the entry cap: matches past it are not listed. */
  truncated: boolean;
}

/** How many entries one filter walk reads before it stops. Main already skips
 *  node_modules and .git; this bounds the rest (build output, vendored trees). */
export const FILTER_SCAN_LIMIT = 5000;

export function nameMatches(name: string, query: string): boolean {
  return name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function sortNodes(nodes: FilterNode[]): FilterNode[] {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) if (n.children) sortNodes(n.children);
  return nodes;
}

/**
 * Breadth-first walk from `root`, reading each folder once through `readDir`.
 * Symlinked folders are listed but not walked into (a link back up the tree
 * would loop). A matched folder is returned collapsed, so expanding it shows
 * its whole content the usual way; folders that only lead to a match come
 * back expanded. `isCancelled` is checked between reads so a newer query can
 * abandon an older walk.
 */
export async function filterTree(
  root: string,
  query: string,
  readDir: (dir: string) => Promise<FilterEntry[]>,
  isCancelled: () => boolean = () => false,
  limit = FILTER_SCAN_LIMIT,
): Promise<FilterResult | null> {
  const q = query.trim();
  // Every folder seen, by path: a match's ancestors are looked up here.
  const folders = new Map<string, FilterEntry>();
  const matches: FilterEntry[] = [];
  const queue: string[] = [root];
  let scanned = 0;
  let truncated = false;

  for (let dir = queue.shift(); dir !== undefined && !truncated; dir = queue.shift()) {
    const entries = await readDir(dir);
    if (isCancelled()) return null;
    for (const entry of entries) {
      if (scanned >= limit) { truncated = true; break; }
      scanned++;
      if (nameMatches(entry.name, q)) matches.push(entry);
      if (entry.isDirectory) {
        folders.set(entry.path, entry);
        if (!entry.isSymlink) queue.push(entry.path);
      }
    }
  }

  return { ...buildTree(matches, (path) => folders.get(parentPath(path))), truncated };
}

function parentPath(path: string): string {
  const sep = path.includes('/') ? '/' : '\\';
  return path.slice(0, path.lastIndexOf(sep));
}

/** Matches plus the folders leading to them, as a tree. Pure. */
export function buildTree(
  matches: FilterEntry[],
  parentFolder: (path: string) => FilterEntry | undefined,
): { nodes: FilterNode[]; matchCount: number } {
  const byPath = new Map<string, FilterNode>();
  const top: FilterNode[] = [];

  const nodeFor = (entry: FilterEntry): FilterNode => {
    let node = byPath.get(entry.path);
    if (node) return node;
    node = { ...entry };
    byPath.set(entry.path, node);
    const parent = parentFolder(entry.path);
    if (parent) {
      const p = nodeFor(parent);
      p.isExpanded = true;
      (p.children ??= []).push(node);
    } else {
      top.push(node);
    }
    return node;
  };

  for (const m of matches) {
    const node = nodeFor(m);
    node.matched = true;
  }
  // A matched folder that only matched (nothing inside it did) stays
  // collapsed and lazy, like any folder in the plain tree.
  for (const node of byPath.values()) {
    if (node.matched && node.isDirectory && !node.children) node.isExpanded = false;
  }
  return { nodes: sortNodes(top), matchCount: matches.length };
}
