/* Department templates (brief 01 fills this in). */
import type { FastifyInstance } from 'fastify';
import { TemplateListSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

export function register(app: FastifyInstance, _deps: AppServices) {
  app.get('/api/templates', async () => TemplateListSchema.parse([]));
}
