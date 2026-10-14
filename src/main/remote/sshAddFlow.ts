// "Add PC over SSH", end to end, from the laptop's side:
//
//   bootstrap over ssh (install, web, pair code)
//     → open the tunnel under a freshly minted host id
//     → redeem the code THROUGH the tunnel (a code burned by bad tries is re-issued)
//     → probe /api/config with the new device credential
//     → persist the host as wmux-ssh://<id>
//
// Nothing is persisted until the credential works, and the tunnel is torn
// down on any failure, so a half-added host leaves neither a record nor a
// running ssh behind.

import * as crypto from 'crypto';
import type { SshHostBinding, WebPairCliResult } from '../../shared/sshPcContract';
import { sshHostOrigin } from '../../shared/sshPcContract';
import type { PairFailureReason, RemoteHostPublic, SshAddPhase, SshAddResult, SshConfirmResult } from '../../shared/remoteHosts';
import { SshFailure, assertSshOk, bootstrapArgs, isValidSshAlias, parseServerHostKey, runSsh } from './sshCommand';
import { BootstrapError, bootstrapHost, issuePairCode, resolveAlias, type BootstrapDeps, type SshRun } from './SshBootstrap';
import { localEndpointFor, pickFreeLoopbackPort, type SshTunnelRegistry } from './SshTunnelSupervisor';

/** Fresh codes tried after one is rejected (the host's slot burns after 5 bad tries). */
const PAIR_ATTEMPTS = 3;

export interface SshAddDeps {
  registry: SshTunnelRegistry;
  manifest: BootstrapDeps['manifest'];
  deviceName: string;
  openArtifact?: BootstrapDeps['openArtifact'];
  run?: SshRun;
  platform?: NodeJS.Platform;
  /** Redeems a code at an origin (remote.handler's exchangePairCode). */
  exchange: (origin: string, code: string, signal?: AbortSignal) => Promise<{ ok: true; token: string } | { ok: false; reason: PairFailureReason }>;
  /** True when the credential answers /api/config. */
  probe: (origin: string, token: string) => Promise<boolean>;
  persist: (id: string, binding: SshHostBinding, token: string, label: string, allowInput: boolean) => { ok: true; host: RemoteHostPublic } | { ok: false; error: string };
  /** An alias already registered (one record per destination). */
  isRegistered: (alias: string) => boolean;
  onPhase?: (phase: SshAddPhase) => void;
  newId?: () => string;
  /** Cancel: kills the ssh in flight and stores nothing. */
  signal?: AbortSignal;
}

/** Redeem a code through the tunnel; a wrong, expired or burned code is worth a fresh one. */
async function redeem(
  run: SshRun,
  alias: string,
  first: WebPairCliResult,
  origin: string,
  deps: Pick<SshAddDeps, 'exchange' | 'deviceName' | 'signal'>,
): Promise<string> {
  let pair = first;
  for (let attempt = 0; attempt < PAIR_ATTEMPTS; attempt += 1) {
    if (deps.signal?.aborted) throw new SshFailure('cancelled', 'cancelled');
    if (attempt > 0) pair = await issuePairCode(run, alias, deps.deviceName, deps.signal);
    const ex = await deps.exchange(origin, pair.code, deps.signal);
    if (ex.ok) return ex.token;
    if (ex.reason !== 'invalid-code' && ex.reason !== 'expired' && ex.reason !== 'too-many-attempts') {
      throw new BootstrapError('web-failed', `pairing failed (${ex.reason})`);
    }
  }
  throw new BootstrapError('web-failed', 'pairing failed (code rejected)');
}

function failureOf(err: unknown): { ok: false; kind: string; message: string } {
  if (err instanceof SshFailure) return { ok: false, kind: err.kind, message: err.message };
  if (err instanceof BootstrapError) return { ok: false, kind: err.refusal, message: err.message };
  return { ok: false, kind: 'failed', message: err instanceof Error ? err.message : String(err) };
}

export async function addSshHost(alias: string, label: string | undefined, deps: SshAddDeps): Promise<SshAddResult> {
  if (!isValidSshAlias(alias)) return { ok: false, kind: 'invalid-alias', message: 'not an ssh host name' };
  if (deps.isRegistered(alias)) return { ok: false, kind: 'already-registered', message: alias };
  const run = deps.run ?? runSsh;
  const id = (deps.newId ?? crypto.randomUUID)();
  try {
    const boot = await bootstrapHost(alias, {
      run,
      manifest: deps.manifest,
      deviceName: deps.deviceName,
      openArtifact: deps.openArtifact,
      onPhase: deps.onPhase,
      signal: deps.signal,
    });
    const platform = deps.platform ?? process.platform;
    const binding: SshHostBinding = {
      alias,
      resolvedHost: boot.resolvedHost,
      hostKeyFingerprint: boot.hostKeyFingerprint,
      remotePort: boot.pair.port,
      localEndpoint: localEndpointFor(
        deps.registry.socketDir,
        id,
        platform === 'win32' ? await pickFreeLoopbackPort() : undefined,
        platform,
      ),
    };
    deps.registry.setPending(id, binding);
    const origin = sshHostOrigin(id);

    const token = await redeem(run, alias, boot.pair, origin, deps);
    deps.onPhase?.('register');
    if (!(await deps.probe(origin, token))) throw new BootstrapError('web-failed', 'the new credential was not accepted');
    if (deps.signal?.aborted) throw new SshFailure('cancelled', 'cancelled');
    const saved = deps.persist(id, binding, token, label?.trim() || alias, boot.pair.allowInput);
    if (!saved.ok) throw new BootstrapError('web-failed', saved.error);
    deps.registry.clearPending(id);
    return {
      ok: true,
      host: saved.host,
      upgradePending: boot.upgradePending,
      // Web was started without input elsewhere and is never restarted here (E2).
      ...(boot.pair.allowInput ? {} : { viewOnly: true }),
    };
  } catch (err) {
    deps.registry.stop(id);
    return failureOf(err);
  }
}

export interface SshRepairDeps {
  deviceName: string;
  run?: SshRun;
  exchange: SshAddDeps['exchange'];
  probe: SshAddDeps['probe'];
  /** Swap the stored credential in place, so attachments keyed by the id survive. */
  replace: (token: string) => { ok: true; host: RemoteHostPublic } | { ok: false; error: string };
}

/**
 * Pair again over SSH: the host stopped accepting this computer's credential
 * (revoked there, or its device store was reset). A fresh code is minted over
 * ssh and redeemed through the existing tunnel; nothing is installed or
 * restarted.
 */
export async function repairSshHost(id: string, binding: SshHostBinding, deps: SshRepairDeps): Promise<SshAddResult> {
  const run = deps.run ?? runSsh;
  const origin = sshHostOrigin(id);
  try {
    const first = await issuePairCode(run, binding.alias, deps.deviceName);
    if (first.port !== binding.remotePort) {
      throw new BootstrapError('web-failed', 'wmux web on that computer now listens on another port; remove and add it again');
    }
    const token = await redeem(run, binding.alias, first, origin, deps);
    if (!(await deps.probe(origin, token))) throw new BootstrapError('web-failed', 'the new credential was not accepted');
    const saved = deps.replace(token);
    if (!saved.ok) throw new BootstrapError('web-failed', saved.error);
    return { ok: true, host: saved.host, upgradePending: false };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * Re-confirmation of a changed host (E7). Without `accept` it only reports
 * what ssh sees now; with `accept` equal to what ssh sees, the caller stores it.
 */
export async function observeSshHost(
  binding: SshHostBinding,
  run: SshRun = runSsh,
): Promise<SshConfirmResult> {
  try {
    const resolved = await resolveAlias(run, binding.alias);
    const res = assertSshOk(await run(bootstrapArgs(binding.alias, ['true']), { timeoutMs: 30_000 }));
    const key = parseServerHostKey(res.stderr);
    if (!key) return { ok: false, kind: 'failed', message: 'could not read the host key ssh was shown' };
    return { ok: true, applied: false, resolvedHost: resolved.hostname, hostKeyFingerprint: key };
  } catch (err) {
    return failureOf(err);
  }
}
