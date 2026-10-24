// N4 — the desktop side of "an agent lost its sign-in" (shared/agentAuthLost).
// The daemon reports per pane; this folds the reports into one entry per agent
// and account, raises one notification when an entry appears, and keeps the
// renderer's copy (its toast and the sidebar's "Signed out") in step. An entry
// goes when the account is seen to work again: a pane of it finished a normal
// turn, or the renderer's [Sign in again] saw the agent's status say signed in.

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import {
  authConfigEnvKey,
  authLostKey,
  parseAgentAuthLost,
  type AgentAuthLost,
  type AuthLostEntry,
} from '../../shared/agentAuthLost';
import { withFreshWindowsPath } from '../../shared/windowsPathEnv';
import { AgentSetupDetector } from '../firstRun/AgentSetupDetector';
import { dispatchNotification } from '../notification/dispatchNotification';
import type { DaemonClient } from '../DaemonClient';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;

/** The entries, keyed by agent and account. Pure, so the rules are testable without Electron. */
export class AuthLostBoard {
  private readonly entries = new Map<string, AuthLostEntry>();

  /** Record a report; true when it opened a new entry (the one that gets a notification). */
  report(ptyId: string, lost: AgentAuthLost): boolean {
    const key = authLostKey(lost.agent, lost.configDir);
    const entry = this.entries.get(key);
    if (entry) {
      if (ptyId && !entry.ptyIds.includes(ptyId)) entry.ptyIds.push(ptyId);
      return false;
    }
    this.entries.set(key, { key, agent: lost.agent, configDir: lost.configDir, ptyIds: ptyId ? [ptyId] : [] });
    return true;
  }

  /** A pane finished a normal turn: its account works, so its entry goes. */
  paneWorks(ptyId: string): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.ptyIds.includes(ptyId)) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }

  /** A pane closed: it stops being one of the entry's panes; the entry stays. */
  forgetPane(ptyId: string): boolean {
    let changed = false;
    for (const entry of this.entries.values()) {
      const at = entry.ptyIds.indexOf(ptyId);
      if (at !== -1) {
        entry.ptyIds.splice(at, 1);
        changed = true;
      }
    }
    return changed;
  }

  clear(key: string): boolean {
    return this.entries.delete(key);
  }

  get(key: string): AuthLostEntry | undefined {
    return this.entries.get(key);
  }

  list(): AuthLostEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, ptyIds: [...e.ptyIds] }));
  }
}

/**
 * [Sign in again]'s check: the agent's own status for an entry the board holds.
 * Signed in drops the entry (returned as `cleared`). An unknown key is not
 * probed, so the renderer can only ask about accounts the daemon reported.
 */
export async function answerLoginState(
  board: AuthLostBoard,
  key: unknown,
  loginState: (entry: AuthLostEntry) => Promise<boolean | null>,
): Promise<{ known: false } | { known: true; signedIn: boolean | null; cleared: boolean }> {
  const entry = typeof key === 'string' ? board.get(key) : undefined;
  if (!entry) return { known: false };
  const signedIn = await loginState(entry).catch(() => null);
  return { known: true, signedIn, cleared: signedIn === true && board.clear(entry.key) };
}

export function registerAgentAuthHandlers(
  daemonClient: DaemonClient | undefined,
  getWindow: () => BrowserWindow | null,
  deps: { loginState?: (entry: AuthLostEntry) => Promise<boolean | null> } = {},
): () => void {
  const board = new AuthLostBoard();
  const loginState = deps.loginState ?? ((entry: AuthLostEntry) => {
    const env = withFreshWindowsPath(process.env);
    if (entry.configDir) env[authConfigEnvKey(entry.agent)] = entry.configDir;
    return new AgentSetupDetector().loginState(entry.agent, env);
  });
  const publish = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.AGENT_AUTH_LOST_CHANGED, board.list());
  };

  const onAuthLost = (payload: { sessionId: string; lost: unknown }): void => {
    if (payload.lost === null) {
      if (board.paneWorks(payload.sessionId)) publish();
      return;
    }
    const lost = parseAgentAuthLost(payload.lost);
    if (!lost) return;
    if (board.report(payload.sessionId, lost)) {
      const name = AGENT_NAME[lost.agent];
      dispatchNotification(getWindow(), payload.sessionId || null, {
        type: 'warning',
        title: `${name} is signed out`,
        body: lost.origin === 'schedule'
          ? `A scheduled run was not started. Sign in to ${name} again to run it.`
          : `${name} cannot run until you sign in again.`,
        category: 'system',
      }, { ptyId: payload.sessionId || null });
    }
    publish();
  };
  const onGone = (payload: { sessionId: string }): void => {
    if (board.forgetPane(payload.sessionId)) publish();
  };

  ipcMain.removeHandler(IPC.AGENT_AUTH_LOST_LIST);
  ipcMain.handle(IPC.AGENT_AUTH_LOST_LIST, () => board.list());
  // Only an entry the daemon reported can be asked about or cleared: the
  // renderer names a key, never a folder, so it cannot point a probe anywhere.
  ipcMain.removeHandler(IPC.AGENT_AUTH_LOGIN_STATE);
  ipcMain.handle(IPC.AGENT_AUTH_LOGIN_STATE, async (_event, key: unknown) => {
    const answer = await answerLoginState(board, key, loginState);
    if (!answer.known) return answer;
    if (answer.cleared) publish();
    return { known: true as const, signedIn: answer.signedIn };
  });

  if (daemonClient) {
    daemonClient.on('agent:authLost', onAuthLost);
    daemonClient.on('session:died', onGone);
    daemonClient.on('session:destroyed', onGone);
  }

  return () => {
    ipcMain.removeHandler(IPC.AGENT_AUTH_LOST_LIST);
    ipcMain.removeHandler(IPC.AGENT_AUTH_LOGIN_STATE);
    if (daemonClient) {
      daemonClient.removeListener('agent:authLost', onAuthLost);
      daemonClient.removeListener('session:died', onGone);
      daemonClient.removeListener('session:destroyed', onGone);
    }
  };
}
