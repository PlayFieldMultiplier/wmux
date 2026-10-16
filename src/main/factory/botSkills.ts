// ─── Bot skills store — each bot's own procedures (shared/botSkill.ts) ──────
//
// One folder per skill under the bot's own folder (BotRuntime.botCwd):
//
//   <wmuxDir>/factory/bots/<botId>/skills/<name>/
//     skill.json                   state, and the hash of each version
//     SKILL.md, references/        the approved version — the only one read
//                                  for a wake, skill_read or a worker
//     proposed/                    the version waiting for the owner
//     denied/<hash>/               the last few proposals the owner denied
//
// Every path is built here from a checked bot id and a checked skill name;
// nothing a caller sends is ever a path. A folder or file that is a symlink,
// or that resolves outside the bot's skills folder, is refused on read and
// on write. A proposal is written into a fresh folder and renamed into
// place, so a write never goes through anything that was already there.
//
// The approved version and a proposal sit side by side: proposing never
// touches what loads. The owner's Approve (an approval card, action `skill`)
// moves the proposal whose hash the card carries into place; Deny moves it
// to denied/.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BOT_ID_RE } from '../../shared/bot';
import {
  SKILL_LIMITS,
  SKILL_NAME_RE,
  SKILL_REFERENCE_NAME_RE,
  WORKER_SKILLS_EXCLUDE_LINE,
  parseSkillFrontmatter,
  skillVersionNewer,
  workerSkillDirName,
  type BotSkillView,
  type SkillIndexEntry,
  type SkillReferenceInput,
  type SkillState,
} from '../../shared/botSkill';

const META_FILE = 'skill.json';
const SKILL_FILE = 'SKILL.md';
const REFERENCES_DIR = 'references';
const PROPOSED_DIR = 'proposed';
const DENIED_DIR = 'denied';
/** Denied proposals kept per skill. */
const DENIED_KEEP = 3;
/** A diff of more lines than this per side is shown as the new text. */
const DIFF_MAX_LINES = 600;

export type SkillRefusalCode = 'invalid' | 'not_found' | 'unsafe_path' | 'too_many' | 'unchanged' | 'stale' | 'write_failed';

export interface SkillRefusal {
  ok: false;
  code: SkillRefusalCode;
  message: string;
}

function refuse(code: SkillRefusalCode, message: string): SkillRefusal {
  return { ok: false, code, message };
}

interface VersionMeta {
  hash: string;
  version: string;
  description: string;
  at: number;
}

interface SkillMeta {
  version: 1;
  name: string;
  state: SkillState;
  approved?: VersionMeta;
  proposed?: VersionMeta & { approvalId?: string; reason: string };
  createdAt: number;
  updatedAt: number;
}

/** One version's files, as written and hashed. */
interface SkillFiles {
  content: string;
  references: SkillReferenceInput[];
}

export interface SkillProposal {
  ok: true;
  skill: BotSkillView;
  /** The proposal's content hash: the owner's card approves this one. */
  hash: string;
  version: string;
  description: string;
  /** An approved version exists: this one would replace it. */
  update: boolean;
  /** What changes against the approved version (or the whole new skill). */
  diff: string;
  /** The same proposal was already waiting: nothing was written. */
  duplicate?: true;
  /** Its card, when the proposal already had one. */
  approvalId?: string;
  /** A different proposal waited and was replaced: its card is moot. */
  replacedApprovalId?: string;
}

export interface ApprovedSkill {
  name: string;
  files: SkillFiles;
}

/** `<wmuxDir>/factory/bots/<botId>/skills` (BotRuntime.botCwd + skills). */
export function botSkillsRoot(wmuxDir: string, botId: string): string {
  return path.join(wmuxDir, 'factory', 'bots', botId, 'skills');
}

/** sha256 over SKILL.md and the references in name order. Pure. */
export function skillHash(files: SkillFiles): string {
  const h = createHash('sha256');
  h.update(`${SKILL_FILE}\0${files.content}\0`);
  for (const r of [...files.references].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${r.name}\0${r.content}\0`);
  return h.digest('hex');
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A line diff of two texts: `- `, `+ ` and `  ` lines, two lines of context
 *  around each change, `@@ line N` before each hunk. Null when either side
 *  is over DIFF_MAX_LINES after the common head and tail. Pure. */
export function skillLineDiff(before: string, after: string): string | null {
  const a0 = before === '' ? [] : before.split('\n');
  const b0 = after === '' ? [] : after.split('\n');
  let head = 0;
  while (head < a0.length && head < b0.length && a0[head] === b0[head]) head += 1;
  let ta = a0.length;
  let tb = b0.length;
  while (ta > head && tb > head && a0[ta - 1] === b0[tb - 1]) {
    ta -= 1;
    tb -= 1;
  }
  const a = a0.slice(head, ta);
  const b = b0.slice(head, tb);
  if (a.length === 0 && b.length === 0) return '';
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  // Every line of both texts as one op, so the context comes along.
  const ops: Array<{ k: ' ' | '-' | '+'; line: string; at: number }> = a0.slice(0, head).map((line, i) => ({ k: ' ' as const, line, at: i + 1 }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ k: ' ', line: a[i], at: head + j + 1 });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      ops.push({ k: '-', line: a[i], at: head + j + 1 });
      i += 1;
    } else {
      ops.push({ k: '+', line: b[j], at: head + j + 1 });
      j += 1;
    }
  }
  for (let t = tb; t < b0.length; t += 1) ops.push({ k: ' ', line: b0[t], at: t + 1 });
  const keep = new Set<number>();
  ops.forEach((op, n) => {
    if (op.k === ' ') return;
    for (let c = Math.max(0, n - 2); c <= Math.min(ops.length - 1, n + 2); c += 1) keep.add(c);
  });
  const out: string[] = [];
  let last = -2;
  ops.forEach((op, n) => {
    if (!keep.has(n)) return;
    if (n !== last + 1) out.push(`@@ line ${op.at}`);
    out.push(`${op.k} ${op.line}`);
    last = n;
  });
  return out.join('\n');
}

/** The change from one version to another, file by file. Pure. */
export function skillFilesDiff(before: SkillFiles | null, after: SkillFiles): string {
  const parts: string[] = [];
  const one = (file: string, from: string, to: string): void => {
    if (from === to) return;
    const d = skillLineDiff(from, to);
    // Every line carries a prefix, so none can close the card's code fence.
    parts.push(`--- ${file}`, d ?? ['@@ too long to compare; the new text', ...to.split('\n').map((l) => `+ ${l}`)].join('\n'));
  };
  one(SKILL_FILE, before?.content ?? '', after.content);
  const names = new Set([...(before?.references ?? []), ...after.references].map((r) => r.name));
  for (const name of [...names].sort()) {
    const from = before?.references.find((r) => r.name === name)?.content ?? '';
    const to = after.references.find((r) => r.name === name)?.content;
    if (to === undefined) parts.push(`--- ${REFERENCES_DIR}/${name} (removed)`);
    else one(`${REFERENCES_DIR}/${name}`, from, to);
  }
  return parts.join('\n');
}

/** A proposal's files, checked: the front matter (its name is the skill's),
 *  the size limits, the reference names. Pure. */
export function validateSkillProposal(name: unknown, content: unknown, references: unknown): { ok: true; files: SkillFiles; version: string; description: string } | SkillRefusal {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return refuse('invalid', 'name is a lowercase slug (a-z, 0-9, -), at most 64 characters');
  if (typeof content !== 'string' || content.length === 0) return refuse('invalid', 'content is the whole SKILL.md');
  if (Buffer.byteLength(content, 'utf8') > SKILL_LIMITS.BODY_MAX) return refuse('invalid', `SKILL.md is at most ${SKILL_LIMITS.BODY_MAX} bytes`);
  const fm = parseSkillFrontmatter(content);
  if (!fm.ok) return refuse('invalid', fm.error);
  if (fm.frontmatter.name !== name) return refuse('invalid', `the front matter's name (${fm.frontmatter.name}) is not ${name}`);
  if (!fm.body.trim()) return refuse('invalid', 'SKILL.md needs the procedure after its front matter');
  const refs: SkillReferenceInput[] = [];
  if (references !== undefined) {
    if (!Array.isArray(references)) return refuse('invalid', 'references is a list of {name, content}');
    if (references.length > SKILL_LIMITS.REFERENCES_MAX) return refuse('invalid', `at most ${SKILL_LIMITS.REFERENCES_MAX} references`);
    let total = 0;
    for (const r of references as unknown[]) {
      const ref = r as Partial<SkillReferenceInput> | null;
      if (!ref || typeof ref.name !== 'string' || !SKILL_REFERENCE_NAME_RE.test(ref.name)) {
        return refuse('invalid', 'a reference name is a slug ending in .md or .txt (no folder)');
      }
      if (typeof ref.content !== 'string') return refuse('invalid', `reference ${ref.name} needs its content`);
      const bytes = Buffer.byteLength(ref.content, 'utf8');
      if (bytes > SKILL_LIMITS.REFERENCE_MAX) return refuse('invalid', `reference ${ref.name} is over ${SKILL_LIMITS.REFERENCE_MAX} bytes`);
      total += bytes;
      if (refs.some((x) => x.name === ref.name)) return refuse('invalid', `reference ${ref.name} is given twice`);
      refs.push({ name: ref.name, content: ref.content });
    }
    if (total > SKILL_LIMITS.REFERENCES_TOTAL_MAX) return refuse('invalid', `the references together are at most ${SKILL_LIMITS.REFERENCES_TOTAL_MAX} bytes`);
  }
  return { ok: true, files: { content, references: refs }, version: fm.frontmatter.version, description: fm.frontmatter.description };
}

function isMeta(v: unknown, name: string): v is SkillMeta {
  const m = v as SkillMeta | null;
  return !!m && typeof m === 'object' && m.version === 1 && m.name === name
    && (m.state === 'proposed' || m.state === 'approved' || m.state === 'archived')
    && Number.isSafeInteger(m.createdAt) && Number.isSafeInteger(m.updatedAt);
}

function view(m: SkillMeta): BotSkillView {
  return {
    name: m.name,
    state: m.state,
    ...(m.approved ? { description: m.approved.description, version: m.approved.version, approvedAt: m.approved.at } : {}),
    ...(m.proposed ? {
      proposed: {
        version: m.proposed.version,
        description: m.proposed.description,
        at: m.proposed.at,
        ...(m.proposed.approvalId ? { approvalId: m.proposed.approvalId } : {}),
      },
    } : {}),
    updatedAt: m.updatedAt,
  };
}

export class BotSkillStore {
  private readonly now: () => number;

  constructor(private readonly opts: { wmuxDir: string; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  // ── paths ──

  /** The bot's skills folder, made when `create`; null when the bot id is
   *  not one, or a folder on the way is a symlink or leaves the bots folder. */
  private root(botId: string, create: boolean): string | null {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return null;
    const bots = path.join(this.opts.wmuxDir, 'factory', 'bots');
    const botDir = path.join(bots, botId);
    const root = path.join(botDir, 'skills');
    for (const p of [botDir, root]) {
      const st = lstatOrNull(p);
      if (st && !st.isDirectory()) return null;
    }
    if (!lstatOrNull(root)) {
      if (!create) return root;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    try {
      if (!isInside(fs.realpathSync.native(root), fs.realpathSync.native(bots))) return null;
    } catch {
      return null;
    }
    return root;
  }

  /** One skill's folder: a real folder inside the root, or absent. */
  private skillDir(botId: string, name: unknown, create: boolean): { dir: string } | SkillRefusal {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return refuse('invalid', 'name is a lowercase slug (a-z, 0-9, -)');
    let root: string | null;
    try {
      root = this.root(botId, create);
    } catch (err) {
      return refuse('write_failed', `the skills folder could not be made: ${String(err)}`);
    }
    if (!root) return refuse('unsafe_path', 'this bot\'s skills folder is not a plain folder of its own');
    const dir = path.join(root, name);
    const st = lstatOrNull(dir);
    if (st && !st.isDirectory()) return refuse('unsafe_path', `skill ${name} is not a plain folder`);
    if (st) {
      try {
        if (!isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root))) return refuse('unsafe_path', `skill ${name} leaves the skills folder`);
      } catch {
        return refuse('unsafe_path', `skill ${name} could not be resolved`);
      }
    }
    return { dir };
  }

  /** A file inside `dir` that is a plain file (never a symlink), or null. */
  private readPlain(dir: string, rel: string): string | null {
    const file = path.join(dir, rel);
    if (!isInside(file, dir)) return null;
    let p = dir;
    for (const seg of rel.split('/')) {
      p = path.join(p, seg);
      const st = lstatOrNull(p);
      if (!st || st.isSymbolicLink()) return null;
    }
    const st = lstatOrNull(file);
    if (!st || !st.isFile() || st.size > SKILL_LIMITS.BODY_MAX + SKILL_LIMITS.REFERENCES_TOTAL_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  }

  /** A version's files from `dir` (the skill folder or proposed/), or null
   *  when SKILL.md is missing or anything there is not a plain file. */
  private readVersion(dir: string): SkillFiles | null {
    const top = lstatOrNull(dir);
    if (!top || !top.isDirectory()) return null;
    const content = this.readPlain(dir, SKILL_FILE);
    if (content === null) return null;
    const references: SkillReferenceInput[] = [];
    const refDir = path.join(dir, REFERENCES_DIR);
    const st = lstatOrNull(refDir);
    if (st) {
      if (!st.isDirectory()) return null;
      for (const name of fs.readdirSync(refDir).sort()) {
        if (!SKILL_REFERENCE_NAME_RE.test(name)) continue;
        const text = this.readPlain(dir, `${REFERENCES_DIR}/${name}`);
        if (text === null) return null;
        references.push({ name, content: text });
      }
    }
    return { content, references };
  }

  private readMeta(dir: string, name: string): SkillMeta | null {
    const text = this.readPlain(dir, META_FILE);
    if (text === null) return null;
    try {
      const m = JSON.parse(text) as unknown;
      return isMeta(m, name) ? m : null;
    } catch {
      return null;
    }
  }

  private writeMeta(dir: string, meta: SkillMeta): void {
    const file = path.join(dir, META_FILE);
    const st = lstatOrNull(file);
    if (st && !st.isFile()) throw new Error(`${META_FILE} is not a plain file`);
    const tmp = path.join(dir, `.${META_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  }

  /** Write a version into a fresh folder under `dir` (never through what is there). */
  private writeFresh(dir: string, files: SkillFiles): string {
    const tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
    fs.writeFileSync(path.join(tmp, SKILL_FILE), files.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (files.references.length > 0) {
      fs.mkdirSync(path.join(tmp, REFERENCES_DIR), { mode: 0o700 });
      for (const r of files.references) {
        fs.writeFileSync(path.join(tmp, REFERENCES_DIR, r.name), r.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
    }
    return tmp;
  }

  // ── reads ──

  /** The bot's skills, by name. Never throws. */
  list(botId: string): BotSkillView[] {
    let root: string | null = null;
    try {
      root = this.root(botId, false);
    } catch {
      root = null;
    }
    if (!root || !lstatOrNull(root)) return [];
    const out: BotSkillView[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(root).filter((n) => SKILL_NAME_RE.test(n)).sort();
    } catch {
      return [];
    }
    for (const name of names) {
      const d = this.skillDir(botId, name, false);
      if (!('dir' in d)) continue;
      const meta = this.readMeta(d.dir, name);
      if (meta) out.push(view(meta));
    }
    return out;
  }

  /** What a wake lists: the approved skills' names and descriptions. */
  index(botId: string): SkillIndexEntry[] {
    return this.list(botId)
      .filter((s) => s.state === 'approved' && s.description !== undefined)
      .map((s) => ({ name: s.name, description: s.description as string }));
  }

  /** The approved version of every approved skill (for a worker's copy). */
  approved(botId: string): ApprovedSkill[] {
    const out: ApprovedSkill[] = [];
    for (const s of this.list(botId)) {
      if (s.state !== 'approved') continue;
      const d = this.skillDir(botId, s.name, false);
      if (!('dir' in d)) continue;
      const meta = this.readMeta(d.dir, s.name);
      const files = this.readVersion(d.dir);
      // Only the bytes the owner approved.
      if (meta?.approved && files && skillHash(files) === meta.approved.hash) out.push({ name: s.name, files });
    }
    return out;
  }

  /** `skill_read`: an approved skill's SKILL.md and its reference names, or
   *  one reference. A proposal is never read. */
  read(botId: string, name: unknown, reference?: unknown): { ok: true; name: string; version: string; content: string; references: string[] } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const skill = name as string;
    const meta = this.readMeta(d.dir, skill);
    if (!meta || meta.state !== 'approved' || !meta.approved) return refuse('not_found', `no approved skill ${skill}`);
    const files = this.readVersion(d.dir);
    if (!files || skillHash(files) !== meta.approved.hash) return refuse('unsafe_path', `skill ${skill} on disk is not the version the owner approved`);
    if (reference !== undefined) {
      if (typeof reference !== 'string' || !SKILL_REFERENCE_NAME_RE.test(reference)) return refuse('invalid', 'reference is a reference file name');
      const ref = files.references.find((r) => r.name === reference);
      if (!ref) return refuse('not_found', `skill ${skill} has no reference ${reference}`);
      return { ok: true, name: skill, version: meta.approved.version, content: ref.content, references: files.references.map((r) => r.name) };
    }
    return { ok: true, name: skill, version: meta.approved.version, content: files.content, references: files.references.map((r) => r.name) };
  }

  // ── writes ──

  /** `skill_propose`: write a proposed version of a skill (an update when
   *  the skill exists). Never changes the approved version. */
  propose(botId: string, raw: { name?: unknown; content?: unknown; references?: unknown; reason?: unknown }): SkillProposal | SkillRefusal {
    const checked = validateSkillProposal(raw.name, raw.content, raw.references);
    if (!checked.ok) return checked;
    const name = raw.name as string;
    const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.REASON_MAX) : '';
    if (!reason) return refuse('invalid', 'reason is required (one line: what you learned, and from what)');
    const d = this.skillDir(botId, name, true);
    if (!('dir' in d)) return d;
    const exists = !!lstatOrNull(d.dir);
    if (!exists && this.list(botId).length >= SKILL_LIMITS.PER_BOT) return refuse('too_many', `a bot keeps at most ${SKILL_LIMITS.PER_BOT} skills; update one of yours instead`);
    const meta = exists ? this.readMeta(d.dir, name) : null;
    if (exists && !meta) return refuse('unsafe_path', `skill ${name} has no readable ${META_FILE}`);
    const hash = skillHash(checked.files);
    const approvedFiles = meta?.approved ? this.readVersion(d.dir) : null;
    if (meta?.approved && meta.state === 'approved' && meta.approved.hash === hash) return refuse('unchanged', `skill ${name} ${meta.approved.version} is already approved with this content`);
    if (meta?.approved && !skillVersionNewer(checked.version, meta.approved.version)) {
      return refuse('invalid', `an update of ${name} takes a version newer than ${meta.approved.version}`);
    }
    const diff = skillFilesDiff(approvedFiles, checked.files);
    if (meta?.proposed?.hash === hash) {
      return {
        ok: true, skill: view(meta), hash, version: checked.version, description: checked.description, update: !!meta.approved, diff, duplicate: true,
        ...(meta.proposed.approvalId ? { approvalId: meta.proposed.approvalId } : {}),
      };
    }
    const at = this.now();
    const next: SkillMeta = {
      version: 1,
      name,
      state: meta?.state ?? 'proposed',
      ...(meta?.approved ? { approved: meta.approved } : {}),
      proposed: { hash, version: checked.version, description: checked.description, at, reason },
      createdAt: meta?.createdAt ?? at,
      updatedAt: at,
    };
    let tmp: string | null = null;
    try {
      if (!exists) fs.mkdirSync(d.dir, { mode: 0o700 });
      tmp = this.writeFresh(d.dir, checked.files);
      const proposedDir = path.join(d.dir, PROPOSED_DIR);
      // rmSync on a symlink removes the link, never what it points at.
      fs.rmSync(proposedDir, { recursive: true, force: true });
      fs.renameSync(tmp, proposedDir);
      tmp = null;
      this.writeMeta(d.dir, next);
    } catch (err) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      return refuse('write_failed', `skill ${name} could not be written: ${String(err)}`);
    }
    return {
      ok: true, skill: view(next), hash, version: checked.version, description: checked.description, update: !!meta?.approved, diff,
      ...(meta?.proposed?.approvalId ? { replacedApprovalId: meta.proposed.approvalId } : {}),
    };
  }

  /** The proposal `hash` now has its approval card. */
  attachApproval(botId: string, name: string, hash: string, approvalId: string): boolean {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return false;
    const meta = this.readMeta(d.dir, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return false;
    try {
      this.writeMeta(d.dir, { ...meta, proposed: { ...meta.proposed, approvalId }, updatedAt: this.now() });
      return true;
    } catch {
      return false;
    }
  }

  /** The owner approved the proposal `hash`: it becomes the approved
   *  version. A proposal that changed since the card was posted is refused. */
  approve(botId: string, name: string, hash: string): { ok: true; skill: BotSkillView } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const meta = this.readMeta(d.dir, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return refuse('stale', `the proposal of ${name} on this card is no longer the one waiting`);
    const proposedDir = path.join(d.dir, PROPOSED_DIR);
    const files = this.readVersion(proposedDir);
    if (!files || skillHash(files) !== hash) return refuse('stale', `the proposal of ${name} on disk is not the one on the card`);
    let tmp: string | null = null;
    try {
      tmp = this.writeFresh(d.dir, files);
      // The approved SKILL.md and references/ move in from the fresh copy.
      fs.rmSync(path.join(d.dir, REFERENCES_DIR), { recursive: true, force: true });
      if (files.references.length > 0) fs.renameSync(path.join(tmp, REFERENCES_DIR), path.join(d.dir, REFERENCES_DIR));
      const live = path.join(d.dir, SKILL_FILE);
      const st = lstatOrNull(live);
      if (st && !st.isFile()) fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(path.join(tmp, SKILL_FILE), live);
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
      fs.rmSync(proposedDir, { recursive: true, force: true });
      const at = this.now();
      const next: SkillMeta = {
        version: 1, name, state: 'approved',
        approved: { hash, version: meta.proposed.version, description: meta.proposed.description, at },
        createdAt: meta.createdAt, updatedAt: at,
      };
      this.writeMeta(d.dir, next);
      return { ok: true, skill: view(next) };
    } catch (err) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      return refuse('write_failed', `skill ${name} could not be approved: ${String(err)}`);
    }
  }

  /** The owner denied (or let lapse) the proposal `hash`: it moves to
   *  denied/; a skill never approved is archived. */
  deny(botId: string, name: string, hash: string): { ok: true; skill: BotSkillView } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const meta = this.readMeta(d.dir, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return refuse('stale', `the proposal of ${name} on this card is no longer the one waiting`);
    try {
      this.shelveProposal(d.dir, hash);
      const next: SkillMeta = { ...meta, state: meta.approved ? meta.state : 'archived', updatedAt: this.now() };
      delete next.proposed;
      this.writeMeta(d.dir, next);
      return { ok: true, skill: view(next) };
    } catch (err) {
      return refuse('write_failed', `the proposal of ${name} could not be archived: ${String(err)}`);
    }
  }

  /** The owner's Archive: nothing of the skill loads any more, and a
   *  waiting proposal is shelved (its card is moot: `approvalId`). */
  archive(botId: string, name: unknown): { ok: true; skill: BotSkillView; approvalId?: string } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const skill = name as string;
    const meta = this.readMeta(d.dir, skill);
    if (!meta) return refuse('not_found', `no skill ${skill}`);
    try {
      if (meta.proposed) this.shelveProposal(d.dir, meta.proposed.hash);
      const next: SkillMeta = { ...meta, state: 'archived', updatedAt: this.now() };
      delete next.proposed;
      this.writeMeta(d.dir, next);
      return { ok: true, skill: view(next), ...(meta.proposed?.approvalId ? { approvalId: meta.proposed.approvalId } : {}) };
    } catch (err) {
      return refuse('write_failed', `skill ${skill} could not be archived: ${String(err)}`);
    }
  }

  /** proposed/ → denied/<hash>/, keeping the newest DENIED_KEEP. */
  private shelveProposal(dir: string, hash: string): void {
    const proposedDir = path.join(dir, PROPOSED_DIR);
    const st = lstatOrNull(proposedDir);
    if (!st) return;
    if (!st.isDirectory()) {
      fs.rmSync(proposedDir, { force: true });
      return;
    }
    const deniedRoot = path.join(dir, DENIED_DIR);
    const rs = lstatOrNull(deniedRoot);
    if (rs && !rs.isDirectory()) fs.rmSync(deniedRoot, { force: true });
    fs.mkdirSync(deniedRoot, { recursive: true, mode: 0o700 });
    const target = path.join(deniedRoot, hash.slice(0, 16));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(proposedDir, target);
    const kept = fs.readdirSync(deniedRoot)
      .map((n) => ({ n, at: lstatOrNull(path.join(deniedRoot, n))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.at - a.at);
    for (const old of kept.slice(DENIED_KEEP)) fs.rmSync(path.join(deniedRoot, old.n), { recursive: true, force: true });
  }

  /** Drop the proposal `hash` (its card could not be posted). */
  discardProposal(botId: string, name: string, hash: string): void {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return;
    const meta = this.readMeta(d.dir, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return;
    try {
      fs.rmSync(path.join(d.dir, PROPOSED_DIR), { recursive: true, force: true });
      if (!meta.approved && meta.state === 'proposed') {
        fs.rmSync(d.dir, { recursive: true, force: true });
        return;
      }
      const next: SkillMeta = { ...meta, updatedAt: this.now() };
      delete next.proposed;
      this.writeMeta(d.dir, next);
    } catch {
      /* the next proposal replaces it */
    }
  }
}

// ── A worker's copy ─────────────────────────────────────────────────────────

/** Runs git in the worktree; never throws. */
export type SkillGitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Copy the bot's approved skills into a worker's worktree as
 *  `.claude/skills/bot-<name>/`, after adding WORKER_SKILLS_EXCLUDE_LINE to
 *  the worktree's `info/exclude` (`git rev-parse --git-path`, the common
 *  one for a linked worktree) so they are never committed. Nothing is copied
 *  when the exclude cannot be written, and a folder already there (one the
 *  repository holds) is left alone. Returns the names copied. */
export async function installWorkerSkills(
  skills: readonly ApprovedSkill[],
  worktree: string,
  deps: { git: SkillGitRun; exclude: (file: string, line: string) => Promise<void> },
): Promise<string[]> {
  if (skills.length === 0) return [];
  const r = await deps.git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], worktree);
  const excludeFile = r.stdout.trim();
  if (r.code !== 0 || !excludeFile || !path.isAbsolute(excludeFile)) throw new Error(`info/exclude not found: ${r.stderr.trim().slice(0, 200)}`);
  await deps.exclude(excludeFile, WORKER_SKILLS_EXCLUDE_LINE);
  const claudeDir = path.join(worktree, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  for (const p of [claudeDir, skillsDir]) {
    const st = lstatOrNull(p);
    if (st && !st.isDirectory()) throw new Error(`${path.relative(worktree, p)} is not a plain folder`);
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  const copied: string[] = [];
  for (const s of skills) {
    const target = path.join(skillsDir, workerSkillDirName(s.name));
    if (lstatOrNull(target)) continue;
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, SKILL_FILE), s.files.content, { encoding: 'utf8', flag: 'wx' });
    if (s.files.references.length > 0) {
      fs.mkdirSync(path.join(target, REFERENCES_DIR));
      for (const ref of s.files.references) fs.writeFileSync(path.join(target, REFERENCES_DIR, ref.name), ref.content, { encoding: 'utf8', flag: 'wx' });
    }
    copied.push(s.name);
  }
  return copied;
}

// ── Singleton (the `skills` module: pipe/handlers/skill.rpc.ts) ────────────

let current: BotSkillStore | null = null;

export function setBotSkillStore(s: BotSkillStore | null): void {
  current = s;
}

export function getBotSkillStore(): BotSkillStore | null {
  return current;
}
