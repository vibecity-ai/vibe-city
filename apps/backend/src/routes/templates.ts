/* Department templates (docs/briefs/01-templates.md). `locked` comes from the game loop (brief 05). */
import type { FastifyInstance } from 'fastify';
import { TEMPLATES, TemplateListSchema, type Template } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

/** The hire grid: every template a CEO can hire, whether it is still locked, and the quest that unlocks it (while
    hiring itself is off, that is the NEAR AI quest). */
export function templateList(locked: (t: Template) => boolean = () => false, hiringOn = true, hired: ReadonlySet<string> = new Set()) {
  return TemplateListSchema.parse(TEMPLATES.filter((t) => !t.hidden).map((t) => ({
    ...t, locked: locked(t), unlocks: hiringOn ? t.unlock : 'connect-ai', hired: hired.has(t.id),
  })));
}

export function register(app: FastifyInstance, deps: AppServices) {
  app.get('/api/templates', async () => {
    const g = await gameState(deps);
    const hired = new Set(deps.departments.list().flatMap((d) => (d.templateId ? [d.templateId] : [])));
    return templateList((t) => g.locked[t.id] ?? false, g.quests.find((q) => q.id === 'connect-ai')?.done ?? true, hired);
  });
}
