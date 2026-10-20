// The "Agent ready" cards' install and sign-in runs.
//
// Every run is a VISIBLE terminal tab typing one line the user confirmed in
// the card; nothing runs in the background and nothing runs without a click.
// The line is typed into the pane's shell, so the shell's own echo is the
// transcript of exactly what ran. The pane runs in the user's own shell and
// environment (PowerShell on Windows, where both vendors' lines are PowerShell
// syntax): wmux adds no proxy and no env.
//
// The watcher lives at module scope, like accountLogin.ts: the wizard steps
// aside while a run's pane is in use, and must find the run again when it
// comes back. A run ends on the first of:
//   - the shell's OSC 133 command-end mark (`133;C` then `133;D;<exit>`),
//     which wmux's shell integration emits for bash, zsh and PowerShell;
//   - detection seeing the result (installed / signed in), polled while the
//     pane is open only, never when idle;
//   - the pane exiting or its tab being closed;
//   - RUN_TIMEOUT_MS.

import { useSyncExternalStore } from 'react';

import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import type { AgentId, AgentSetupStatus } from '../../shared/agentSetup';
import {
  classifyInstallFailure,
  type AgentCommandShell,
  type AgentSetupPlan,
  type InstallFailureKind,
} from '../../shared/agentInstall';
import { claudeSetupScreen, type ClaudeSetupScreen } from '../../shared/claudeFirstRun';
import { agentRow } from '../../shared/agentIdentity';
import { openTerminalTab } from './accountLogin';
import { readPtyBufferTail } from './terminalTail';
import { showWorkspaces } from './showWorkspaces';
import { withDefaultShell } from './ptyCreateOptions';

export type AgentRunKind = 'install' | 'login';

/**
 *  - `running`    the pane is open and the line has not finished.
 *  - `succeeded`  detection confirms it (installed / signed in).
 *  - `failed`     install: the line exited non-zero (see `failure`).
 *  - `not-found`  install: the line finished but wmux still cannot find the
 *                 agent (the card shows where it looked and a path field).
 *  - `closed`     the pane went away, or the agent exited, before success.
 *                 For a sign-in this is "Log in again".
 *  - `no-tab`     no pane could be opened; the card shows the line to copy.
 */
export type AgentRunPhase = 'running' | 'succeeded' | 'failed' | 'not-found' | 'closed' | 'no-tab';

export interface AgentRun {
  /** Unique per start: a late callback of an earlier run never touches a newer one. */
  id: number;
  agent: AgentId;
  kind: AgentRunKind;
  command: string;
  phase: AgentRunPhase;
  ptyId: string | null;
  workspaceId: string | null;
  failure?: InstallFailureKind;
  /** Claude's first-run screen on the sign-in pane right now, for the guide card. */
  screen?: ClaudeSetupScreen | null;
}

export interface AgentSetupState {
  statuses: AgentSetupStatus[] | null;
  checking: boolean;
  runs: Partial<Record<AgentId, AgentRun>>;
}

export const RUN_TICK_MS = 1000;
/** Detection probes spawn processes: every third tick, not every tick. */
export const DETECT_EVERY_TICKS = 3;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PANE_TAIL_LINES = 40;

let state: AgentSetupState = { statuses: null, checking: false, runs: {} };
const listeners = new Set<() => void>();

function set(next: Partial<AgentSetupState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function setRun(agent: AgentId, runId: number, patch: Partial<AgentRun>): void {
  const cur = state.runs[agent];
  if (!cur || cur.id !== runId) return;
  set({ runs: { ...state.runs, [agent]: { ...cur, ...patch } } });
}

export function subscribeAgentSetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAgentSetupState(): AgentSetupState {
  return state;
}

export function useAgentSetup(): AgentSetupState {
  return useSyncExternalStore(subscribeAgentSetup, getAgentSetupState, getAgentSetupState);
}

function firstRunApi() {
  return window.electronAPI?.firstRun;
}

let inflight: Promise<AgentSetupStatus[] | null> | null = null;

/**
 * Re-read both cards. Concurrent callers share one round of probes, unless
 * `fresh`: then the answer comes from a round that starts after this call
 * (a run that just ended must not be judged by a probe begun before it did).
 */
export function refreshAgentStatus(opts: { fresh?: boolean } = {}): Promise<AgentSetupStatus[] | null> {
  if (opts.fresh && inflight) {
    return inflight.then(() => refreshAgentStatus(), () => refreshAgentStatus());
  }
  if (!inflight) {
    const api = firstRunApi();
    if (!api?.agentStatus) return Promise.resolve(state.statuses);
    set({ checking: true });
    inflight = api.agentStatus()
      .then((statuses) => { set({ statuses, checking: false }); return statuses; })
      .catch(() => { set({ checking: false }); return state.statuses; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function agentStatusOf(agent: AgentId, statuses = state.statuses): AgentSetupStatus | null {
  return statuses?.find((s) => s.agent === agent) ?? null;
}

/** Has this run reached its goal, by detection? */
export function runSucceeded(kind: AgentRunKind, status: AgentSetupStatus | null): boolean {
  if (!status) return false;
  return kind === 'install' ? status.readiness !== 'not-installed' : status.readiness === 'ready';
}

/** Longest unterminated tail kept between chunks (a mark is ~12 bytes). */
const MARK_CARRY_MAX = 256;

/**
 * Finds the end of the line the pane ran in raw PTY output: the first
 * terminated `133;D[;exit]` (BEL or ST) after a terminated `133;C`. Exported
 * for tests. Chunks may split a mark anywhere, so the caller passes back
 * `rest` (everything after the last complete mark, capped) with the next chunk.
 */
export function scanCommandEnd(
  text: string,
  started: boolean,
): { started: boolean; ended: boolean; exitCode: number | null; rest: string } {
  let s = started;
  let consumed = 0;
  // eslint-disable-next-line no-control-regex -- OSC 133 marks are control bytes
  const re = /\x1b\]133;([CD])(?:;(-?\d+))?[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    consumed = re.lastIndex;
    if (m[1] === 'C') s = true;
    else if (s) return { started: true, ended: true, exitCode: m[2] !== undefined ? Number(m[2]) : null, rest: '' };
  }
  // Keep only what could still be the start of a mark.
  const tail = text.slice(consumed);
  const esc = tail.lastIndexOf('\x1b]');
  const rest = esc >= 0 ? tail.slice(esc).slice(-MARK_CARRY_MAX) : (tail.endsWith('\x1b') ? '\x1b' : '');
  return { started: s, ended: false, exitCode: null, rest };
}

let nextRunId = 1;

/**
 * The shell a macOS/Linux setup pane will spawn, by the same rule every new
 * pane uses (`withDefaultShell`): the user's chosen shell when it is a real
 * executable path, otherwise undefined, and main then starts `$SHELL`. Passed
 * to `agentPlan` so the sign-in line is quoted for that shell.
 */
export function effectivePaneShell(defaultShell: string | undefined): string | undefined {
  return withDefaultShell({}, defaultShell).shell;
}

function shellFor(shell: AgentCommandShell): string | undefined {
  return shell === 'powershell' ? 'powershell.exe' : undefined;
}

/** The home folder, or the first workspace's own folder when it has one. */
function runCwd(): string | null {
  const ws = useStore.getState().workspaces[0];
  return ws?.profile?.startupCwd || null;
}

const watches = new Map<AgentId, () => void>();

function stopWatch(agent: AgentId): void {
  watches.get(agent)?.();
  watches.delete(agent);
}

function paneText(ptyId: string): string {
  return readPtyBufferTail(ptyId, PANE_TAIL_LINES).join('\n');
}

function tabStillOpen(workspaceId: string, ptyId: string): boolean {
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  return getWorkspaceLeafPanes(ws).some((p) => p.surfaces.some((s) => s.ptyId === ptyId));
}

/**
 * Open the pane and type the line. One run per agent: starting another
 * (Retry, Log in again) ends the watch on the previous one.
 */
const starting = new Map<AgentId, Promise<AgentRun>>();

export function startAgentRun(
  agent: AgentId,
  kind: AgentRunKind,
  plan: AgentSetupPlan,
  title: string,
): Promise<AgentRun> {
  // One pane at a time per agent: a second click while a tab is being opened
  // gets that run, not a second tab.
  const pending = starting.get(agent);
  if (pending) return pending;
  const p = openRun(agent, kind, plan, title).finally(() => { starting.delete(agent); });
  starting.set(agent, p);
  return p;
}

async function openRun(
  agent: AgentId,
  kind: AgentRunKind,
  plan: AgentSetupPlan,
  title: string,
): Promise<AgentRun> {
  stopWatch(agent);
  const line = kind === 'install' ? plan.install : plan.login;
  const command = line?.command ?? '';
  const base: AgentRun = { id: nextRunId++, agent, kind, command, phase: 'no-tab', ptyId: null, workspaceId: null };
  if (!line) {
    set({ runs: { ...state.runs, [agent]: base } });
    return base;
  }
  const shell = shellFor(line.shell);
  const tab = await openTerminalTab({
    initialCommand: command,
    title,
    cwd: runCwd(),
    plainEnv: true,
    ...(shell ? { shell } : {}),
  });
  if (!tab) {
    set({ runs: { ...state.runs, [agent]: base } });
    return base;
  }
  const run: AgentRun = { ...base, phase: 'running', ptyId: tab.ptyId, workspaceId: tab.workspaceId, screen: null };
  set({ runs: { ...state.runs, [agent]: run } });
  watch(run.id, agent, kind, tab.workspaceId, tab.ptyId);
  // The user may have switched workspace or page while the tab opened: the
  // line must run in view, so bring its workspace, pane and tab to the front.
  showAgentRunPane(agent);
  return run;
}

function watch(runId: number, agent: AgentId, kind: AgentRunKind, workspaceId: string, ptyId: string): void {
  let started = false;
  let carry = '';
  let ticks = 0;
  let ending = false;
  const startedAt = Date.now();
  const pty = window.electronAPI?.pty;

  const finish = async (exitCode: number | null | undefined, paneGone: boolean): Promise<void> => {
    if (ending) return;
    ending = true;
    stop();
    const statuses = await refreshAgentStatus({ fresh: true });
    const status = agentStatusOf(agent, statuses);
    if (runSucceeded(kind, status)) {
      setRun(agent, runId, { phase: 'succeeded', screen: null });
      return;
    }
    if (kind === 'login' || paneGone || exitCode === undefined) {
      setRun(agent, runId, { phase: 'closed', screen: null });
      return;
    }
    // `curl … | sh` exits with the shell's status, so a failed download can
    // still end 0: read the pane before calling it "installed but not found".
    const failure = classifyInstallFailure(paneText(ptyId));
    if (exitCode === 0 && failure === 'unknown') {
      setRun(agent, runId, { phase: 'not-found' });
      return;
    }
    setRun(agent, runId, { phase: 'failed', failure });
  };

  const offData = pty?.onData?.((id: string, data: string, replay: boolean) => {
    if (id !== ptyId || replay) return;
    const scan = scanCommandEnd(carry + data, started);
    started = scan.started;
    carry = scan.rest;
    if (scan.ended) void finish(scan.exitCode, false);
  });
  const offExit = pty?.onExit?.((id: string) => {
    if (id === ptyId) void finish(undefined, true);
  });

  const timer = setInterval(() => {
    ticks++;
    if (!tabStillOpen(workspaceId, ptyId)) {
      void finish(undefined, true);
      return;
    }
    if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
      void finish(undefined, false);
      return;
    }
    if (kind === 'login' && agentRow(agent)?.setup?.firstRunScreens) {
      const screen = claudeSetupScreen(paneText(ptyId));
      if (screen !== (state.runs[agent]?.screen ?? null)) setRun(agent, runId, { screen });
    }
    if (ticks % DETECT_EVERY_TICKS === 0) {
      void refreshAgentStatus().then((statuses) => {
        if (!ending && runSucceeded(kind, agentStatusOf(agent, statuses))) void finish(null, false);
      });
    }
  }, RUN_TICK_MS);

  function stop(): void {
    clearInterval(timer);
    offData?.();
    offExit?.();
    if (watches.get(agent) === stop) watches.delete(agent);
  }
  watches.set(agent, stop);
}

/** "View log": bring the run's pane to the front. False when it is gone. */
export function showAgentRunPane(agent: AgentId): boolean {
  const run = state.runs[agent];
  if (!run?.ptyId || !run.workspaceId) return false;
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === run.workspaceId);
  const pane = ws && getWorkspaceLeafPanes(ws).find((p) => p.surfaces.some((x) => x.ptyId === run.ptyId));
  const surface = pane?.surfaces.find((x) => x.ptyId === run.ptyId);
  if (!ws || !pane || !surface) return false;
  if (s.activeWorkspaceId !== ws.id) s.setActiveWorkspace(ws.id);
  s.setActivePane(pane.id);
  // The run's own tab, not whichever tab the pane had in front.
  s.setActiveSurface(pane.id, surface.id, ws.id);
  showWorkspaces(useStore.getState());
  return true;
}

/** Forget a finished run (the card goes back to its detected state). */
export function clearAgentRun(agent: AgentId): void {
  stopWatch(agent);
  if (!state.runs[agent]) return;
  const runs = { ...state.runs };
  delete runs[agent];
  set({ runs });
}

/** Test seam. */
export function resetAgentSetupForTests(): void {
  for (const agent of [...watches.keys()]) stopWatch(agent);
  starting.clear();
  inflight = null;
  state = { statuses: null, checking: false, runs: {} };
}
