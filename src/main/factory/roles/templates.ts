// The template definitions, by template — light enough for the wake prompt
// (../wakePrompt.ts) to read a bot's current default job without the roles
// module's ports.

import { botTemplate, type BotProfile, type BotTemplate } from '../../../shared/bot';
import { templateTextsFor, type TemplateDefinition } from './common';
import { COORDINATOR_TEMPLATE } from './coordinator';
import { DEVELOPER_TEMPLATE } from './developer';
import { REVIEWER_TEMPLATE } from './reviewer';
import { ISSUE_TEMPLATE } from './issue';
import { RESEARCHER_TEMPLATE } from './researcher';
import { CUSTOM_TEMPLATE } from './custom';
import { MAINTAINER_TEMPLATE } from './maintainer';

export const TEMPLATE_DEFINITIONS: Readonly<Record<BotTemplate, TemplateDefinition>> = {
  coordinator: COORDINATOR_TEMPLATE,
  developer: DEVELOPER_TEMPLATE,
  reviewer: REVIEWER_TEMPLATE,
  issue: ISSUE_TEMPLATE,
  researcher: RESEARCHER_TEMPLATE,
  custom: CUSTOM_TEMPLATE,
};

/** The definition a profile's prompt is built from: its template's; a
 *  Custom bot of the legacy `maintainer` role keeps the maintainer's job. */
export function templateDefinitionOf(profile: Pick<BotProfile, 'role' | 'template'>): TemplateDefinition {
  const template = botTemplate(profile);
  return template === 'custom' && profile.role === 'maintainer' ? MAINTAINER_TEMPLATE : TEMPLATE_DEFINITIONS[template];
}

/** The job a bot does now: the owner's words, else its template's default
 *  (the one its session's tools can carry out). */
export function effectiveJob(profile: Pick<BotProfile, 'role' | 'template' | 'job' | 'engine' | 'repo'>): string {
  return profile.job ?? templateTextsFor(templateDefinitionOf(profile), profile).defaultJob;
}
