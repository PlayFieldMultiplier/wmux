// ─── The tool gate of a worker with a signed-in connection ─────────────────
//
// A PreToolUse hook (matcher `.*`) on every tool call of a bot's worker whose
// task has a signed-in connection (main/connectors/workerGateway.ts). It is an
// allowlist: a call passes only when it is one of
//   - the file tools (Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep),
//     on a path inside the task folder or its temp folder, as
//     factory/botFolderPath.ts checkBotFolderPath decides (no `..`, the
//     nearest existing parent's real path inside, an existing final component
//     a regular file, no protected name), with `.mcp.json`, `CLAUDE.md` and
//     `CLAUDE.local.md` protected too (`.claude` already is); a Glob pattern
//     or a Grep file filter stays relative;
//   - Bash (the OS sandbox holds its commands), TodoWrite, ToolSearch (which
//     loads the connection's tools);
//   - the task's gateway connections' tools (the gateway holds the owner's
//     tool list) and wmux's ledger_update.
// Anything else (Task, Agent, WebFetch, the other wmux tools, any other MCP
// server) is refused. The hook runs as `node "<script>" || exit 2`, so a hook
// that cannot run refuses too; the script refuses on any error.
//
// The script is plain JavaScript main writes per launch, content-named under
// `<wmuxDir>/factory/worker-hooks/`, with its policy (the folders, the tools,
// the protected names) in it. Its path check is a port of checkBotFolderPath;
// workerToolGate.os.test.ts runs both on the same cases.

import { BOT_FOLDER_PROTECTED_NAMES } from '../factory/botFolderPath';
import { BOT_REPO_SECRET_PATTERNS } from '../factory/botRepoRead';

/** The built-in tools a gated worker may call. */
export const WORKER_GATE_BUILTIN_TOOLS: readonly string[] = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'ToolSearch'];

/** The wmux tools a gated worker may call: it reports its task, nothing else. */
export const WORKER_GATE_WMUX_TOOLS: readonly string[] = ['ledger_update'];

/** Names protected inside the folder on top of checkBotFolderPath's. */
export const WORKER_GATE_EXTRA_PROTECTED: readonly string[] = ['.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md'];

export interface WorkerToolGatePolicy {
  /** The task folder first, then its temp folder. */
  roots: readonly string[];
  /** The gateway connections' names (their tools pass by name prefix). */
  connections: readonly string[];
}

/** The hook script for one launch. Pure. */
export function workerToolGateScript(policy: WorkerToolGatePolicy): string {
  const data = {
    roots: policy.roots,
    builtin: WORKER_GATE_BUILTIN_TOOLS,
    mcp: [...policy.connections.map((c) => `mcp__${c}__`)],
    wmux: WORKER_GATE_WMUX_TOOLS.map((t) => `mcp__wmux__${t}`),
    protectedNames: [...BOT_FOLDER_PROTECTED_NAMES, ...WORKER_GATE_EXTRA_PROTECTED],
    secretPatterns: BOT_REPO_SECRET_PATTERNS,
  };
  return `'use strict';
// wmux: the tool gate of a bot worker with a signed-in connection (generated).
const fs = require('fs');
const path = require('path');
const P = ${JSON.stringify(data)};
const SECRET = P.secretPatterns.map((p) => ({ p, re: new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('.*') + '$', 'i') }));
function refuse(msg) { process.stderr.write('wmux: ' + msg + '\\n'); process.exit(2); }
function inside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel;
}
function protectedName(rel) {
  const segs = rel.split(/[\\\\/]+/).filter((s) => s && s !== '.');
  for (const s of segs) { const hit = SECRET.find((m) => m.re.test(s)); if (hit) return hit.p; }
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k].toLowerCase();
    const hit = P.protectedNames.find((n) => n.toLowerCase() === s);
    if (hit) return hit;
    if (s === '.github' && (segs[k + 1] || '').toLowerCase() === 'workflows') return '.github/workflows';
  }
  return null;
}
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
// checkBotFolderPath (factory/botFolderPath.ts), for one root.
function check(requested, root, directory) {
  if (typeof requested !== 'string' || requested.length === 0) return 'a file path is required';
  if (requested.includes('\\0')) return 'the path is malformed';
  if (requested.split(/[\\\\/]+/).includes('..')) return 'a path with ".." is not used';
  let realDir;
  try { realDir = fs.realpathSync.native(root); } catch { return 'the task folder is not readable'; }
  const lexical = path.resolve(root, requested);
  const rel = inside(root, lexical) ?? inside(realDir, lexical);
  if (rel === null || (rel === '' && !directory)) return 'it is outside the task folder';
  const hit = protectedName(rel);
  if (hit) return 'it is a protected file (' + hit + ')';
  const missing = [];
  let cursor = lexical;
  for (;;) {
    if (lstat(cursor)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) return 'no part of the path exists';
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let realParent;
  try { realParent = fs.realpathSync.native(cursor); } catch { return 'the path could not be resolved'; }
  const real = missing.length > 0 ? path.join(realParent, ...missing) : realParent;
  const realRel = inside(realDir, real);
  if (realRel === null || (realRel === '' && !directory)) return 'it resolves outside the task folder';
  const realHit = protectedName(realRel);
  if (realHit) return 'it is a protected file (' + realHit + ')';
  if (missing.length === 0) {
    const st = lstat(lexical);
    if (!st) return 'the path could not be resolved';
    if (st.isSymbolicLink()) return 'it is a symbolic link';
    if (!st.isFile() && !(directory && st.isDirectory())) return 'it is not a regular file';
  }
  return null;
}
function confine(requested, directory) {
  // A relative path is the working folder's (the task folder); a home path
  // is not taken.
  if (typeof requested === 'string' && requested.startsWith('~')) refuse('a home path is not used: ' + requested);
  const roots = typeof requested === 'string' && !path.isAbsolute(requested) ? P.roots.slice(0, 1) : P.roots;
  let why = null;
  for (const root of roots) { why = check(requested, root, directory); if (why === null) return; }
  refuse('only the task folder is open to this worker: ' + String(requested) + ' (' + why + ')');
}
function relativeGlob(g, what) {
  if (typeof g !== 'string') return;
  const s = g.replace(/^!/, '');
  if (path.isAbsolute(s) || /^[\\\\/~]/.test(s) || /^[A-Za-z]:/.test(s) || /(^|[\\\\/{,])\\.\\.([\\\\/},]|$)/.test(s)) refuse('a ' + what + ' stays inside the task folder: ' + g);
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const call = JSON.parse(raw);
    const name = String(call.tool_name || '');
    const input = call.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {};
    if (P.mcp.some((prefix) => name.startsWith(prefix)) || P.wmux.includes(name)) process.exit(0);
    if (!P.builtin.includes(name)) refuse(name + ' is not available to a task with a signed-in connection');
    if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') confine(input.file_path, false);
    else if (name === 'NotebookEdit') confine(input.notebook_path, false);
    else if (name === 'Glob') { if (input.path !== undefined) confine(input.path, true); relativeGlob(input.pattern, 'pattern'); }
    else if (name === 'Grep') { if (input.path !== undefined) confine(input.path, true); relativeGlob(input.glob, 'file filter'); }
    process.exit(0);
  } catch (err) {
    refuse('the tool gate could not read the call');
  }
});
`;
}
