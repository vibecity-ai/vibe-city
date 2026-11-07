/* Department templates (docs/briefs/01-templates.md). `locked` and `unlocks` come from the game loop (brief 05). */
import type { FastifyInstance } from 'fastify';
import { TEMPLATES, TemplateListSchema, type Template } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

/** The hire grid: every template a CEO can hire, with whether it is still locked. */
export function templateList(locked: (t: Template) => boolean = () => false) {
  return TemplateListSchema.parse(TEMPLATES.filter((t) => !t.hidden).map((t) => ({ ...t, locked: locked(t), unlocks: t.unlock })));
}

export function register(app: FastifyInstance, _deps: AppServices) {
  app.get('/api/templates', async () => templateList());
}
