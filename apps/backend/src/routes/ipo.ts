/* The IPO (brief 06 fills this in). Until then: locked. */
import type { FastifyInstance } from 'fastify';
import { IpoStateSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

export function register(app: FastifyInstance, _deps: AppServices) {
  app.get('/api/ipo', async () => IpoStateSchema.parse({ daoAccountId: null, tokenAccountId: null, txHashes: [], state: 'locked', error: null }));
}
