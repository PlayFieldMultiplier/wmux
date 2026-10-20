/**
 * The subagent count on a roster row: a muted trailer, only while the agent
 * has subagents running. A source scan in the house style of the roster
 * guards next to it, plus the copy in en and ko.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { en } from '../../../i18n/locales/en';
import { ko } from '../../../i18n/locales/ko';

const rosterSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceAgentRoster.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('roster subagent count', () => {
  it('renders only when there is a count, in muted text, with no wash', () => {
    expect(rosterSource).toContain('{subagentLabel && (');
    const at = rosterSource.indexOf('data-roster-subagents');
    expect(at).toBeGreaterThan(-1);
    const tag = rosterSource.slice(rosterSource.lastIndexOf('<span', at), at);
    expect(tag).toContain('text-[var(--text-muted)]');
    expect(tag).not.toMatch(/\bbg-/);
  });

  it('rides the row\'s accessible name', () => {
    expect(rosterSource).toContain('unverifiableLabel ?? statusLabel, subagentLabel, elapsed');
  });

  it('has singular and plural copy in en and ko', () => {
    expect(en['roster.subagentsOne']).toBe('1 subagent');
    expect(en['roster.subagents']).toBe('{count} subagents');
    expect(ko['roster.subagentsOne']).toBe('하위 에이전트 1개');
    expect(ko['roster.subagents']).toBe('하위 에이전트 {count}개');
  });
});
