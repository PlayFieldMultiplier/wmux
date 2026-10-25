// === The firewall Fix and Remove, one human click at a time ===
//
// The renderer asks; main decides and runs. Main keeps the last probe each
// listener showed the person, and a Fix runs only for what that probe said:
// a fixable verdict, no refusal, and the same program and port the daemon
// reports at click time (read again here). Then:
//
//   build the script (netFirewallScripts.ts, every input validated)
//   → one elevation (Windows consent prompt / macOS admin sheet)
//   → re-probe, whatever the outcome: the fresh probe, not the exit code,
//     is what the UI says about the rule
//   → record a rule the re-probe confirmed (firewall-rules.json), or forget
//     one a Remove took away.
//
// One elevation at a time across all listeners; a second click while one
// runs is refused as busy.

import {
  elevationKind,
  elevationOutcome,
  isFixableVerdict,
  type ElevationOutcome,
  type FirewallActionResult,
  type FirewallListener,
  type InboundStatus,
  type InboundStatusView,
} from '../../shared/netFirewall';
import {
  FirewallInputError,
  buildFixScript,
  buildMacFixAppleScript,
  buildRemoveScript,
  firewallRuleIds,
  type RuleScope,
} from '../../shared/netFirewallScripts';
import type { ListenProblemReport } from '../../shared/netListen';
import type { ShellRunResult } from './elevate';

/** The probe's 8 s deadline plus the powershell.exe spawn: above the control pipe's default. */
export const INBOUND_STATUS_RPC_TIMEOUT_MS = 12_000;
/** The holder lookup's 3 s per tool, two netstat reads and a tasklist, plus the trial binds. */
export const LISTEN_PROBLEM_RPC_TIMEOUT_MS = 12_000;

interface FirewallTarget {
  exe: string;
  platform: string;
  applicable: boolean;
  port: number | null;
  tailnet: boolean;
}

export interface FirewallFixDeps {
  /** The daemon control pipe. */
  rpc: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  /** Windows: run the script through the consent prompt (elevate.ts). */
  elevateWindows: (script: string) => Promise<ShellRunResult>;
  /** macOS: run the AppleScript `with administrator privileges` (verify on Mac). */
  elevateMac: (appleScript: string) => Promise<ElevationOutcome>;
  exists: (p: string) => boolean;
  scope: RuleScope;
  /** TOKEN_ELEVATION_TYPE and whether wmux itself runs elevated, for the hint's wording. */
  tokenType: () => number | null;
  selfElevated: () => boolean | null;
  log?: (msg: string) => void;
}

function isStatus(v: unknown): v is InboundStatus {
  return !!v && typeof v === 'object' && typeof (v as InboundStatus).verdict === 'string' && typeof (v as InboundStatus).listener === 'string';
}

export class FirewallFixer {
  private readonly seen = new Map<FirewallListener, InboundStatus>();
  private busy = false;

  constructor(private readonly deps: FirewallFixDeps) {}

  /** Run the read-only probe and remember what it showed. */
  async status(listener: FirewallListener): Promise<InboundStatusView> {
    const raw = await this.deps.rpc('net.inboundStatus', { listener }, { timeoutMs: INBOUND_STATUS_RPC_TIMEOUT_MS });
    if (!isStatus(raw)) throw new Error('net.inboundStatus: malformed daemon response');
    this.seen.set(listener, raw);
    return { ...raw, elevation: elevationKind(this.deps.tokenType(), this.deps.selfElevated()) };
  }

  async listenProblem(listener: FirewallListener): Promise<ListenProblemReport | null> {
    return (await this.deps.rpc('net.listenProblem', { listener }, { timeoutMs: LISTEN_PROBLEM_RPC_TIMEOUT_MS })) as ListenProblemReport | null;
  }

  fix(listener: FirewallListener): Promise<FirewallActionResult> {
    return this.once(listener, 'fix');
  }

  remove(listener: FirewallListener): Promise<FirewallActionResult> {
    return this.once(listener, 'remove');
  }

  private async once(listener: FirewallListener, action: 'fix' | 'remove'): Promise<FirewallActionResult> {
    if (this.busy) return { outcome: { kind: 'refused', refusal: 'busy' }, status: null };
    this.busy = true;
    try {
      return await this.run(listener, action);
    } finally {
      this.busy = false;
    }
  }

  private async run(listener: FirewallListener, action: 'fix' | 'remove'): Promise<FirewallActionResult> {
    const shown = this.seen.get(listener);
    const refused = (refusal: Extract<FirewallActionResult['outcome'], { kind: 'refused' }>['refusal']): FirewallActionResult => ({
      outcome: { kind: 'refused', refusal },
      status: shown ?? null,
    });
    // Only what the person was shown: a Fix for a fixable verdict, a Remove for our covering rule.
    if (!shown || !shown.applicable || shown.port === null) return refused('changed');
    if (shown.refusal) return refused(shown.refusal);
    if (action === 'fix' ? !isFixableVerdict(shown.verdict) : shown.verdict !== 'covered') return refused('changed');

    const target = (await this.deps.rpc('net.firewallTarget', { listener })) as FirewallTarget;
    if (!target || !target.applicable || target.port !== shown.port || target.exe !== shown.exe) return refused('changed');

    let outcome: ElevationOutcome;
    if (shown.platform === 'darwin') {
      if (action === 'remove') return refused('unsupported-platform');
      let script: string;
      try {
        script = buildMacFixAppleScript(target.exe);
      } catch (err) {
        if (err instanceof FirewallInputError) return refused(err.reason === 'bad-input' ? 'changed' : err.reason);
        throw err;
      }
      outcome = await this.deps.elevateMac(script);
    } else if (shown.platform === 'win32') {
      // The rule IDs the person saw must be the ones this script writes.
      const ids = firewallRuleIds(listener, target.exe, this.deps.scope);
      if (shown.ruleIds?.allow !== ids.allow || shown.ruleIds?.pubblock !== ids.pubblock) return refused('changed');
      let script: string;
      try {
        script =
          action === 'fix'
            ? buildFixScript({ listener, port: target.port, exe: shown.exe, reportedExe: target.exe, tailnet: target.tailnet, scope: this.deps.scope, exists: this.deps.exists })
            : buildRemoveScript({ listener, exe: shown.exe, reportedExe: target.exe, scope: this.deps.scope, exists: this.deps.exists });
      } catch (err) {
        if (err instanceof FirewallInputError) return refused(err.reason === 'bad-input' ? 'changed' : err.reason);
        throw err;
      }
      outcome = elevationOutcome(await this.deps.elevateWindows(script));
    } else {
      return refused('unsupported-platform');
    }
    this.deps.log?.(`[net] firewall ${action} for ${listener}: ${outcome.kind}`);

    // Whatever happened, the probe says what is true now.
    let status: InboundStatus | null = null;
    try {
      status = await this.status(listener);
    } catch (err) {
      this.deps.log?.(`[net] re-probe after ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (status && shown.platform === 'win32') {
      if (action === 'fix' && status.verdict === 'covered') await this.record(listener, 'set');
      if (action === 'remove' && status.verdict !== 'covered' && status.verdict !== 'unknown') await this.record(listener, 'clear');
    }
    return { outcome, status };
  }

  private async record(listener: FirewallListener, op: 'set' | 'clear'): Promise<void> {
    try {
      await this.deps.rpc('net.firewallRecord', { listener, op });
    } catch (err) {
      this.deps.log?.(`[net] could not ${op} the firewall record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
