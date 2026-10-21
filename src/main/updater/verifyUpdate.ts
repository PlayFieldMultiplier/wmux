/**
 * NN2-T4 — pure, electron-free verification logic for the auto-updater.
 *
 * Before v2.14.x the updater handed the user an UNVERIFIED binary: it called
 * shell.openExternal(url) on a URL taken verbatim from the update server, with
 * no integrity check at all. A compromised release artifact or a redirect MITM
 * was undetectable client-side — the single biggest supply-chain gap for a tool
 * that auto-edits ~/.claude.json and drives a logged-in browser.
 *
 * This module holds the security decisions (URL allowlist, manifest validation,
 * constant-time digest comparison) as pure functions so they can be unit-tested
 * without electron. AutoUpdater wires the download/launch plumbing around them.
 * The contract is FAIL-CLOSED: any uncertainty rejects the install.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeVersion } from '../../shared/updateVersion';

export interface UpdateManifest {
  version: string;
  /**
   * Artifact file name, normalized across platforms: the Windows manifest
   * publishes it as `setupExe` (unchanged, for backward compatibility with
   * already-shipped clients), the darwin manifest as `file`.
   */
  fileName: string;
  sha256: string;
  url: string;
}

export type ManifestResult =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; reason: string };

// Shared with the renderer, which compares the feed's and the manifest's
// spellings of the same version (Settings › Updates).
export { normalizeVersion } from '../../shared/updateVersion';

/**
 * Only https downloads from github.com (the release host) are accepted. The
 * release asset 302-redirects to objects.githubusercontent.com; we validate the
 * INITIAL url here and let the HTTP client follow the redirect.
 */
export function isAllowedDownloadUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com');
}

/** Constant-time, case-insensitive comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na.length === 0 || na.length !== nb.length) return false;
  try {
    return timingSafeEqual(Buffer.from(na, 'utf8'), Buffer.from(nb, 'utf8'));
  } catch {
    return false;
  }
}

/** SHA-256 hex digest of a buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Validate a fetched manifest is well-formed, points at an allowlisted https
 * github.com URL, carries a 64-char hex SHA-256, and matches the version the
 * update server offered (defends against a stale/wrong manifest). Returns a
 * typed, trusted manifest or a rejection reason.
 */
export function validateManifest(raw: unknown, offeredVersion: string): ManifestResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'manifest is not an object' };
  const o = raw as Record<string, unknown>;
  // `setupExe` (Windows manifest) or `file` (darwin manifest) — either one names
  // the artifact; everything else is validated identically on both platforms.
  const fileName = typeof o.setupExe === 'string' ? o.setupExe
    : typeof o.file === 'string' ? o.file
      : null;
  if (
    typeof o.version !== 'string' ||
    fileName === null ||
    typeof o.sha256 !== 'string' ||
    typeof o.url !== 'string'
  ) {
    return { ok: false, reason: 'manifest missing required string fields (version/setupExe|file/sha256/url)' };
  }
  if (!/^[a-f0-9]{64}$/i.test(o.sha256.trim())) {
    return { ok: false, reason: 'sha256 is not a 64-char hex digest' };
  }
  if (!isAllowedDownloadUrl(o.url)) {
    return { ok: false, reason: `download url is not an allowed https github.com url: ${o.url}` };
  }
  if (normalizeVersion(o.version) !== normalizeVersion(offeredVersion)) {
    return { ok: false, reason: `manifest version "${o.version}" does not match offered update "${offeredVersion}"` };
  }
  return {
    ok: true,
    manifest: { version: o.version, fileName, sha256: o.sha256.trim(), url: o.url },
  };
}

/**
 * A verified installer is parked in temp as `wmux-update-<version>-<pid>-<file>`.
 * That name is the ONLY record of what the file is: the downloaded path lives in
 * memory and a restart clears it, so a later run has to read the name back to
 * recognize an installer it already has (#995). Format and parse therefore live
 * together — they are one contract, and a drift between them silently turns
 * every parked artifact into garbage.
 */
export const TEMP_ARTIFACT_PREFIX = 'wmux-update-';

export interface ParsedArtifactName {
  version: string;
  pid: number;
  /** Artifact name as sanitized when it was written, e.g. `wmux-3.45.0.Setup.exe`. */
  fileName: string;
}

/** The manifest's artifact name, reduced to characters a temp file name may hold. */
export function sanitizeArtifactFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Build the temp file name for a downloaded artifact.
 *
 * BOTH halves are sanitized. The manifest is fetched over the network, and this
 * name is join()ed onto the temp dir — a `version` carrying a path separator
 * would place the "temp file" wherever it liked. The version is attacker-
 * controlled in exactly the scenario this module exists for.
 */
export function artifactTempName(version: string, pid: number, fileName: string): string {
  return `${TEMP_ARTIFACT_PREFIX}${sanitizeArtifactFileName(version)}-${pid}-${sanitizeArtifactFileName(fileName)}`;
}

/** Read `<version>`, `<pid>` and `<file>` back out of a temp artifact name. */
export function parseArtifactName(name: string): ParsedArtifactName | null {
  // The version is matched as semver, not as "anything", and its optional
  // prerelease is greedy: `3.46.0-1-12345-wmux.Setup.exe` has to read as
  // version 3.46.0-1 / pid 12345, not version 3.46.0 / pid 1 with the rest
  // swallowed into the file name. A name this cannot parse is simply not one
  // of ours — the caller then downloads instead of adopting, which is the safe
  // direction.
  const m = new RegExp(
    `^${TEMP_ARTIFACT_PREFIX}(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]*)?)-(\\d+)-(.+)$`,
  ).exec(name);
  if (!m) return null;
  return { version: m[1], pid: Number(m[2]), fileName: m[3] };
}

/**
 * Strict semver 2.0.0: MAJOR.MINOR.PATCH, an optional `-prerelease` of
 * dot-separated identifiers, an optional `+build`. Numeric parts carry no
 * leading zeros. Kept as one expression so the feed check and the version
 * comparison below agree on what a version is.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemver {
  core: [number, number, number];
  /** Prerelease identifiers; empty for a release. */
  prerelease: string[];
}

function parseSemver(v: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(normalizeVersion(v));
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * The update feed's `name`, accepted only when it is a strict semver with an
 * optional leading `v` (release tags are `vX.Y.Z`). The name becomes the
 * pending version: it is compared against the manifest, stamped into the
 * install marker and shown in Settings, so anything else is an error rather
 * than something to make sense of. Returns the name unchanged, or null.
 */
export function parseFeedVersion(name: unknown): string | null {
  if (typeof name !== 'string' || name.length > 64) return null;
  const bare = name.startsWith('v') ? name.slice(1) : name;
  return SEMVER_RE.test(bare) ? name : null;
}

/** Semver precedence of two prerelease identifiers. */
function compareIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  // A numeric identifier ranks below an alphanumeric one.
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True when `candidate` is a strictly newer release than `current`, by semver
 * precedence: the numeric core first, then the prerelease. A release outranks
 * any prerelease of the same core (3.46.0 > 3.46.0-beta.2), prereleases
 * compare identifier by identifier (beta.2 > beta.1, beta.10 > beta.2), and
 * build metadata is ignored.
 *
 * Anything that does not parse as semver answers FALSE, which is the
 * conservative side: the caller treats such an artifact as ordinary garbage
 * on the normal sweep schedule instead of keeping it around.
 */
export function isVersionNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === 0 && b.prerelease.length > 0;
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifier(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c > 0;
  }
  return a.prerelease.length > b.prerelease.length;
}
