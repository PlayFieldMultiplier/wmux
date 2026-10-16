// A bot's own skills: the store keeps each skill inside the bot's folder
// (no `..`, no absolute name, no symlink out); a proposal never loads until
// the owner approves its card (the `skill` approval kind), Deny archives it;
// a wake lists approved skills only; a worker's copy stays out of git.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, BrowserWindow: class {} }));

import type { BotBinding, BotProfile } from '../../../shared/bot';
import { SKILL_LIMITS, WORKER_SKILLS_EXCLUDE_LINE, parseSkillFrontmatter } from '../../../shared/botSkill';
import { BOT_APPROVAL_RPC } from '../../../shared/botApproval';
import type { RpcContext } from '../../../shared/rpc';
import { BotSkillStore, botSkillsRoot, installWorkerSkills, skillFilesDiff, skillLineDiff, type SkillGitRun } from '../botSkills';
import { ApprovalService, registerApprovalRpc, type ApprovalWake } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { wakeSkills } from '../wakeContext';
import { buildWakePrompt } from '../wakePrompt';
import { excludeLineOnce } from '../../git/infoExclude';
import { registerSkillHandlers, skillApprovalHost } from '../../pipe/handlers/skill.rpc';

const WS = 'ws-1';
const A = 'bot-0000000a';
const B = 'bot-0000000b';

const profile = (id: string): BotProfile => ({
  version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  enabled: true, createdAt: 0, updatedAt: 0,
});
const binding = (id: string): BotBinding => ({ workspaceId: WS, botId: id, role: 'lead' });

const skillMd = (name: string, version = '1.0.0', body = 'Run the gate before you report.\n', description = 'How to report a task') =>
  `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n---\n${body}`;

let dir = '';
let wmuxDir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-skills-'));
  wmuxDir = path.join(dir, 'wmux');
  fs.mkdirSync(path.join(wmuxDir, 'factory', 'bots'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(): BotSkillStore {
  return new BotSkillStore({ wmuxDir, now: () => 1_000 });
}

function propose(s: BotSkillStore, botId: string, name: string, content = skillMd(name), references?: unknown) {
  const r = s.propose(botId, { name, content, reason: 'the owner corrected my report', ...(references ? { references } : {}) });
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
  return r;
}

describe('SKILL.md front matter', () => {
  it('takes exactly name, description and version', () => {
    expect(parseSkillFrontmatter(skillMd('report'))).toMatchObject({ ok: true, frontmatter: { name: 'report', description: 'How to report a task', version: '1.0.0' } });
    expect(parseSkillFrontmatter('name: x\n')).toMatchObject({ ok: false });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: d\n---\nbody')).toMatchObject({ ok: false, error: 'front matter needs version' });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: d\nversion: 1.0.0\nallowed-tools: Bash\n---\nbody')).toMatchObject({ ok: false });
    expect(parseSkillFrontmatter('---\nname: ../x\ndescription: d\nversion: 1.0.0\n---\nbody')).toMatchObject({ ok: false });
    expect(parseSkillFrontmatter('---\nname: x\ndescription: d\nversion: v1\n---\nbody')).toMatchObject({ ok: false });
  });
});

describe('skill store: writing and path containment', () => {
  it('writes a proposal under the bot\'s own folder and reads nothing of it as a skill', () => {
    const s = store();
    const p = propose(s, A, 'report', skillMd('report'), [{ name: 'checklist.md', content: '- gate\n' }]);
    expect(p).toMatchObject({ update: false, version: '1.0.0', skill: { name: 'report', state: 'proposed' } });
    const dirOf = path.join(botSkillsRoot(wmuxDir, A), 'report');
    expect(fs.readFileSync(path.join(dirOf, 'proposed', 'SKILL.md'), 'utf8')).toBe(skillMd('report'));
    expect(fs.readFileSync(path.join(dirOf, 'proposed', 'references', 'checklist.md'), 'utf8')).toBe('- gate\n');
    // Not loaded: no approved SKILL.md, no index entry, no read, no worker copy.
    expect(fs.existsSync(path.join(dirOf, 'SKILL.md'))).toBe(false);
    expect(s.index(A)).toEqual([]);
    expect(s.read(A, 'report')).toMatchObject({ ok: false, code: 'not_found' });
    expect(s.approved(A)).toEqual([]);
    // Another bot sees none of it.
    expect(s.list(B)).toEqual([]);
  });

  it('refuses names that are paths: .., separators, absolute paths', () => {
    const s = store();
    for (const name of ['..', '../b', 'a/b', 'a\\b', '/etc/passwd', '.hidden', 'Upper', '']) {
      expect(s.propose(A, { name, content: skillMd('x'), reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
      expect(s.read(A, name)).toMatchObject({ ok: false });
    }
    for (const ref of ['../x.md', '/abs.md', 'sub/x.md', 'x.sh', '..md']) {
      expect(s.propose(A, { name: 'report', content: skillMd('report'), references: [{ name: ref, content: 'x' }], reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    }
    // The bot id is checked too: a path is never a bot.
    expect(s.propose('../bot-0000000a', { name: 'report', content: skillMd('report'), reason: 'r' })).toMatchObject({ ok: false, code: 'unsafe_path' });
    // A refused name made no folder at all.
    expect(fs.readdirSync(path.join(wmuxDir, 'factory', 'bots'))).toEqual([]);
  });

  it('refuses a skill folder, a file or the skills folder that is a symlink pointing out of the store', () => {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), skillMd('evil'));
    const s = store();
    // skills/<name> → outside
    fs.mkdirSync(botSkillsRoot(wmuxDir, A), { recursive: true });
    fs.symlinkSync(outside, path.join(botSkillsRoot(wmuxDir, A), 'evil'));
    expect(s.propose(A, { name: 'evil', content: skillMd('evil'), reason: 'r' })).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(s.read(A, 'evil')).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(fs.readdirSync(outside)).toEqual(['SKILL.md']);
    // The bot's whole skills folder → outside
    fs.mkdirSync(path.join(wmuxDir, 'factory', 'bots', B));
    fs.symlinkSync(outside, botSkillsRoot(wmuxDir, B));
    expect(s.propose(B, { name: 'report', content: skillMd('report'), reason: 'r' })).toMatchObject({ ok: false, code: 'unsafe_path' });
    expect(s.list(B)).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual(['SKILL.md']);
    // An approved SKILL.md swapped for a symlink is not read.
    const t = propose(s, A, 'report');
    expect(s.approve(A, 'report', t.hash)).toMatchObject({ ok: true });
    const live = path.join(botSkillsRoot(wmuxDir, A), 'report', 'SKILL.md');
    fs.rmSync(live);
    fs.symlinkSync(path.join(outside, 'SKILL.md'), live);
    expect(s.read(A, 'report')).toMatchObject({ ok: false });
    expect(s.index(A)).toEqual([{ name: 'report', description: 'How to report a task' }]);
    expect(s.approved(A)).toEqual([]);
  });

  it('holds the size limits and the front matter\'s name', () => {
    const s = store();
    expect(s.propose(A, { name: 'report', content: skillMd('other'), reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.propose(A, { name: 'report', content: skillMd('report', '1.0.0', 'x'.repeat(SKILL_LIMITS.BODY_MAX)), reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.propose(A, { name: 'report', content: skillMd('report'), references: [{ name: 'a.md', content: 'x'.repeat(SKILL_LIMITS.REFERENCE_MAX + 1) }], reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `r${i}.md`, content: 'x'.repeat(SKILL_LIMITS.REFERENCE_MAX) }));
    expect(s.propose(A, { name: 'report', content: skillMd('report'), references: many, reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.propose(A, { name: 'report', content: skillMd('report'), reason: ' ' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('skill store: approve, deny, update, archive', () => {
  it('approve makes the proposal the loaded version; a changed proposal is stale', () => {
    const s = store();
    const first = propose(s, A, 'report');
    const second = propose(s, A, 'report', skillMd('report', '1.0.0', 'Gate, then report.\n'));
    expect(second.replacedApprovalId).toBeUndefined();
    // The card of the first proposal no longer matches what waits.
    expect(s.approve(A, 'report', first.hash)).toMatchObject({ ok: false, code: 'stale' });
    expect(s.approve(A, 'report', second.hash)).toMatchObject({ ok: true, skill: { state: 'approved', version: '1.0.0' } });
    expect(s.read(A, 'report')).toMatchObject({ ok: true, content: skillMd('report', '1.0.0', 'Gate, then report.\n') });
    expect(s.index(A)).toEqual([{ name: 'report', description: 'How to report a task' }]);
  });

  it('an update never changes what loads until it is approved, and needs a newer version', () => {
    const s = store();
    s.approve(A, 'report', propose(s, A, 'report').hash);
    expect(s.propose(A, { name: 'report', content: skillMd('report'), reason: 'r' })).toMatchObject({ ok: false, code: 'unchanged' });
    expect(s.propose(A, { name: 'report', content: skillMd('report', '1.0.0', 'new\n'), reason: 'r' })).toMatchObject({ ok: false, code: 'invalid' });
    const up = propose(s, A, 'report', skillMd('report', '1.1.0', 'Gate, lint, then report.\n', 'How to report a task, with lint'));
    expect(up).toMatchObject({ update: true, skill: { state: 'approved', version: '1.0.0', proposed: { version: '1.1.0' } } });
    expect(up.diff).toContain('- Run the gate before you report.');
    expect(up.diff).toContain('+ Gate, lint, then report.');
    // Still the approved 1.0.0 everywhere.
    expect(s.read(A, 'report')).toMatchObject({ ok: true, version: '1.0.0', content: skillMd('report') });
    expect(s.index(A)).toEqual([{ name: 'report', description: 'How to report a task' }]);
    expect(s.approved(A)[0].files.content).toBe(skillMd('report'));
    expect(s.approve(A, 'report', up.hash)).toMatchObject({ ok: true, skill: { version: '1.1.0' } });
    expect(s.read(A, 'report')).toMatchObject({ ok: true, version: '1.1.0' });
  });

  it('deny archives the proposal: a new skill is archived, an approved one keeps its version', () => {
    const s = store();
    const fresh = propose(s, A, 'fresh');
    expect(s.deny(A, 'fresh', fresh.hash)).toMatchObject({ ok: true, skill: { state: 'archived' } });
    expect(fs.existsSync(path.join(botSkillsRoot(wmuxDir, A), 'fresh', 'denied', fresh.hash.slice(0, 16), 'SKILL.md'))).toBe(true);
    expect(s.list(A).find((x) => x.name === 'fresh')?.proposed).toBeUndefined();

    s.approve(A, 'report', propose(s, A, 'report').hash);
    const up = propose(s, A, 'report', skillMd('report', '2.0.0', 'other\n'));
    expect(s.deny(A, 'report', up.hash)).toMatchObject({ ok: true, skill: { state: 'approved', version: '1.0.0' } });
    expect(s.read(A, 'report')).toMatchObject({ ok: true, version: '1.0.0' });
  });

  it('archive unloads a skill and shelves a waiting proposal (its card is moot)', () => {
    const s = store();
    const p = propose(s, A, 'report');
    s.attachApproval(A, 'report', p.hash, 'apr-12345678');
    expect(s.archive(A, 'report')).toMatchObject({ ok: true, approvalId: 'apr-12345678', skill: { state: 'archived' } });
    expect(s.approve(A, 'report', p.hash)).toMatchObject({ ok: false, code: 'stale' });
    expect(s.index(A)).toEqual([]);
  });
});

describe('line diff', () => {
  it('shows removed and added lines with context', () => {
    expect(skillLineDiff('a\nb\nc', 'a\nB\nc')).toBe('@@ line 1\n  a\n- b\n+ B\n  c');
    expect(skillLineDiff('same', 'same')).toBe('');
    expect(skillFilesDiff(null, { content: 'x', references: [{ name: 'r.md', content: 'y' }] })).toBe('--- SKILL.md\n@@ line 1\n+ x\n--- references/r.md\n@@ line 1\n+ y');
  });
});

// ── The owner's approval card ───────────────────────────────────────────────

function approvalRig() {
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const skills = store();
  const wakes = new Map<string, ApprovalWake>([[A, { wakeId: 'w-1', attempt: 1, threadId: null, tainted: false }]]);
  const notices: string[] = [];
  const events: string[] = [];
  const svc = new ApprovalService({
    file: path.join(wmuxDir, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [profile(A)], get: (id) => (id === A ? profile(A) : null) }),
    runningWake: (id) => wakes.get(id) ?? null,
    readPr: async () => { throw new Error('no PR'); },
    ghLogin: async () => null,
    rooms: () => writer,
    merge: () => null,
    notice: (n) => notices.push(n.title),
    skills: () => skillApprovalHost(() => skills, (e) => events.push(e.type)),
    now: () => 5_000,
    log: () => undefined,
  });
  const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
  const router = { register: (m: string, h: (raw: unknown, ctx?: RpcContext) => Promise<unknown>) => { handlers.set(m, h); } };
  registerSkillHandlers(router as never, { store: () => skills, approvals: () => svc, emit: (e) => events.push(e.type) });
  registerApprovalRpc(router as never, () => svc);
  const ctx = { bot: binding(A) } as RpcContext;
  const call = (method: string, raw: unknown, c: RpcContext | undefined = ctx) => (handlers.get(method) as (raw: unknown, ctx?: RpcContext) => Promise<Record<string, unknown>>)(raw, c);
  return { svc, writer, skills, wakes, notices, events, call };
}

describe('skill_propose → approval card → load', () => {
  it('a proposal raises one approval card with its diff; nothing loads before Approve', async () => {
    const r = approvalRig();
    const res = await r.call('skill.propose', { name: 'report', content: skillMd('report'), reason: 'the owner corrected my report' });
    expect(res).toMatchObject({ ok: true, skill: { state: 'proposed' } });
    const req = r.svc.get(res.approvalId as string);
    expect(req).toMatchObject({ action: 'skill', state: 'pending', skill: { name: 'report', version: '1.0.0', update: false }, botId: A });
    const card = r.writer.get(WS, req?.cardId as string);
    expect(card).toMatchObject({ kind: 'approval', title: 'Add the skill report 1.0.0?' });
    expect(card?.body).toContain('```diff\n--- SKILL.md');
    expect(card?.body).toContain('+ Run the gate before you report.');
    expect(card?.body).not.toContain('does not carry this act out');
    // Not loaded.
    expect(await r.call('skill.read', { name: 'report' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(wakeSkills({ skills: () => r.skills } as never, profile(A))).toEqual([]);
    // The same proposal again is that card, not a second one.
    const again = await r.call('skill.propose', { name: 'report', content: skillMd('report'), reason: 'again' });
    expect(again).toMatchObject({ ok: true, duplicate: true, approvalId: res.approvalId });
    expect(r.svc.listForOperator(WS)).toHaveLength(1);
  });

  it('Approve loads it (approved), and the bot is told; Deny archives it', async () => {
    const r = approvalRig();
    const res = await r.call('skill.propose', { name: 'report', content: skillMd('report'), reason: 'r' });
    expect(r.svc.decide({ requestId: res.approvalId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    expect(r.skills.list(A)).toMatchObject([{ name: 'report', state: 'approved', version: '1.0.0' }]);
    expect(await r.call('skill.read', { name: 'report' })).toMatchObject({ ok: true, content: skillMd('report') });
    expect(r.notices.at(-1)).toBe('The owner approved your skill report 1.0.0.');

    const other = await r.call('skill.propose', { name: 'triage', content: skillMd('triage'), reason: 'r' });
    expect(r.svc.decide({ requestId: other.approvalId, decision: 'deny' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'denied' } });
    expect(r.skills.list(A).find((s) => s.name === 'triage')).toMatchObject({ state: 'archived' });
    expect(r.skills.index(A).map((s) => s.name)).toEqual(['report']);
  });

  it('a newer proposal withdraws the older card; approving the old card is refused', async () => {
    const r = approvalRig();
    const one = await r.call('skill.propose', { name: 'report', content: skillMd('report'), reason: 'r' });
    const two = await r.call('skill.propose', { name: 'report', content: skillMd('report', '1.0.1'), reason: 'r' });
    expect(r.svc.get(one.approvalId as string)?.state).toBe('expired');
    expect(r.svc.decide({ requestId: one.approvalId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'not_pending' });
    expect(r.svc.decide({ requestId: two.approvalId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true });
    expect(r.skills.read(A, 'report')).toMatchObject({ ok: true, version: '1.0.1' });
  });

  it('a skill is never asked through approval_request, never approved by a rule or typed words, and needs a wake', async () => {
    const r = approvalRig();
    expect(await r.call(BOT_APPROVAL_RPC.request, { action: 'skill', reason: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    const res = await r.call('skill.propose', { name: 'report', content: skillMd('report'), reason: 'r' });
    expect(r.svc.decide({ requestId: res.approvalId, decision: 'always' }, 'desktop')).toMatchObject({ ok: false, code: 'not_ruleable' });
    const said = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', refs: { botId: A } });
    if (!said.ok) throw new Error('post failed');
    expect(r.svc.onOwnerCard(said.card)).toEqual([]);
    expect(r.svc.get(res.approvalId as string)?.state).toBe('pending');
    // Between wakes: refused, and the written proposal is dropped again.
    r.wakes.delete(A);
    expect(await r.call('skill.propose', { name: 'triage', content: skillMd('triage'), reason: 'r' })).toMatchObject({ ok: false, code: 'not_running' });
    expect(r.skills.list(A).map((s) => s.name)).toEqual(['report']);
    // A caller without a bot binding is refused.
    expect(await r.call('skill.propose', { name: 'x', content: skillMd('x'), reason: 'r' }, {} as RpcContext)).toMatchObject({ ok: false, code: 'not_bot' });
  });
});

describe('the wake lists approved skills only', () => {
  it('names and descriptions of approved skills, fenced as data; proposals never', () => {
    const s = store();
    s.approve(A, 'report', propose(s, A, 'report').hash);
    propose(s, A, 'pending-one', skillMd('pending-one', '1.0.0', 'x\n', 'Not yet approved'));
    propose(s, A, 'report', skillMd('report', '1.1.0', 'y\n', 'Waiting update'));
    const listed = wakeSkills({ skills: () => s } as never, profile(A));
    expect(listed).toEqual([{ name: 'report', description: 'How to report a task' }]);
    const item = { id: 'w-1', botId: A, workspaceId: WS, reason: { kind: 'human' }, priority: 1, attempts: 1 } as never;
    const text = buildWakePrompt({ item, profile: profile(A), skills: listed });
    expect(text).toContain('Your skills (approved by the owner; read one with skill_read');
    expect(text).toContain('report: How to report a task');
    expect(text).not.toContain('pending-one');
    expect(text).not.toContain('Waiting update');
    expect(buildWakePrompt({ item, profile: profile(A), skills: [] })).not.toContain('Your skills');
  });
});

// ── A worker's copy ─────────────────────────────────────────────────────────

const realGit: SkillGitRun = async (args, cwd) => {
  try {
    return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: String(err) };
  }
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
}

describe('a worker gets the approved skills, out of git', () => {
  it('copies only approved skills into a linked worktree\'s .claude/skills/bot-<name>/ and git status stays clean', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', 'shared', 'SKILL.md'), 'tracked\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'wtask/x', wt);

    const s = store();
    s.approve(A, 'report', propose(s, A, 'report', skillMd('report'), [{ name: 'checklist.md', content: '- gate\n' }]).hash);
    propose(s, A, 'pending-one');
    const copied = await installWorkerSkills(s.approved(A), wt, { git: realGit, exclude: excludeLineOnce });
    expect(copied).toEqual(['report']);
    expect(fs.readFileSync(path.join(wt, '.claude', 'skills', 'bot-report', 'SKILL.md'), 'utf8')).toBe(skillMd('report'));
    expect(fs.readFileSync(path.join(wt, '.claude', 'skills', 'bot-report', 'references', 'checklist.md'), 'utf8')).toBe('- gate\n');
    expect(fs.existsSync(path.join(wt, '.claude', 'skills', 'bot-pending-one'))).toBe(false);
    // The repository's own skills are untouched, and nothing shows in git.
    expect(fs.readFileSync(path.join(wt, '.claude', 'skills', 'shared', 'SKILL.md'), 'utf8')).toBe('tracked\n');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain(WORKER_SKILLS_EXCLUDE_LINE);
    // A second worker adds the line once.
    await installWorkerSkills(s.approved(A), wt, { git: realGit, exclude: excludeLineOnce });
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === WORKER_SKILLS_EXCLUDE_LINE)).toHaveLength(1);
  });

  it('copies nothing when the exclude cannot be found', async () => {
    const notRepo = path.join(dir, 'plain');
    fs.mkdirSync(notRepo);
    const s = store();
    s.approve(A, 'report', propose(s, A, 'report').hash);
    await expect(installWorkerSkills(s.approved(A), notRepo, { git: realGit, exclude: excludeLineOnce })).rejects.toThrow(/info\/exclude/);
    expect(fs.existsSync(path.join(notRepo, '.claude'))).toBe(false);
  });
});
