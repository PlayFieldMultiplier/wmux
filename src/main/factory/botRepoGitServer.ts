// The in-process MCP server that holds git_show and git_diff for a
// repository-reading bot's SDK session. botRepoGit.ts has the rules; this
// file only wires them to the MCP SDK, so the prompts that name the tools
// need not load it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BOT_REPO_GIT_PATHS_MAX, BOT_REPO_GIT_SERVER, gitDiff, gitShow, repoGitRead, type GitRead, type GitToolResult } from './botRepoGit';

/**
 * The in-process MCP server a repository-reading bot's session holds:
 * git_show and git_diff in `root`. `refusal` is asked on every call (the
 * guest check, a second lock behind the session's tool gate); a reason
 * refuses it.
 */
export function createBotRepoGitServer(root: string, refusal: () => string | null, run: GitRead = repoGitRead) {
  const server = new McpServer({ name: BOT_REPO_GIT_SERVER, version: '1.0.0' });
  const answer = async (fn: () => Promise<GitToolResult>) => {
    let r: GitToolResult;
    try {
      const why = refusal();
      r = why ? { ok: false, reason: why } : await fn();
    } catch {
      r = { ok: false, reason: 'the git read failed' };
    }
    return r.ok
      ? { content: [{ type: 'text' as const, text: r.text }] }
      : { content: [{ type: 'text' as const, text: `wmux: ${r.reason}` }], isError: true };
  };
  server.registerTool('git_show', {
    description: 'Read one file (or list one folder) of your repository at a commit: rev is a commit SHA (7-40 hex) or a ref name (origin/main, a worker\'s branch), path is relative to the repository root. '
      + 'Commits a worker made in its worktree are readable here as soon as it commits.',
    inputSchema: { rev: z.string().min(1).max(250), path: z.string().min(1).max(1000) },
  }, async ({ rev, path }) => answer(() => gitShow(root, { rev, path }, run)));
  server.registerTool('git_diff', {
    description: 'Read what head changed since it left base (git diff base...head, as a pull request shows it) in your repository: the changed files with their status, then the patch. '
      + 'base and head are commit SHAs (7-40 hex) or ref names; paths (optional) limits it to those files or folders.',
    inputSchema: {
      base: z.string().min(1).max(250),
      head: z.string().min(1).max(250),
      paths: z.array(z.string().min(1).max(1000)).max(BOT_REPO_GIT_PATHS_MAX).optional(),
    },
  }, async ({ base, head, paths }) => answer(() => gitDiff(root, { base, head, paths }, run)));
  return { type: 'sdk' as const, name: BOT_REPO_GIT_SERVER, instance: server };
}
