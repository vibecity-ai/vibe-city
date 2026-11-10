/* The IPO (docs/briefs/06-ipo.md): launch it, then revenue share proposals. The game loop decides when it unlocks. */
import type { FastifyInstance } from 'fastify';
import { IpoAllocateSchema, IpoDividendSchema, IpoLaunchSchema, IpoStateSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  const unlocked = async () => (await gameState(deps)).ipoUnlocked;
  app.get('/api/ipo', async () => IpoStateSchema.parse(await deps.ipo.view(await unlocked())));
  app.post('/api/ipo', async (req) => {
    const body = IpoLaunchSchema.parse(req.body);
    return IpoStateSchema.parse(await deps.ipo.launch(body, await unlocked()));
  });
  app.post('/api/ipo/allocate', async (req) => IpoStateSchema.parse(await deps.ipo.allocate(IpoAllocateSchema.parse(req.body))));
  app.post('/api/ipo/dividend', async (req) => IpoStateSchema.parse(await deps.ipo.dividend(IpoDividendSchema.parse(req.body))));
}
