/* The IPO (docs/briefs/06-ipo.md): launch it (DAO, city token, public offering), then revenue share and closing the
   offering by DAO proposals. The game loop decides when it unlocks and what the company earned (the offer's price). */
import type { FastifyInstance } from 'fastify';
import { IpoDividendSchema, IpoLaunchSchema, IpoStateSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  const game = async () => { const g = await gameState(deps); return { unlocked: g.ipoUnlocked, earned: g.runway.earnedCents }; };
  app.get('/api/ipo', async () => { const g = await game(); return IpoStateSchema.parse(await deps.ipo.view(g.unlocked, g.earned)); });
  app.post('/api/ipo', async (req) => {
    const body = IpoLaunchSchema.parse(req.body);
    const g = await game();
    return IpoStateSchema.parse(await deps.ipo.launch(body, g.unlocked, g.earned));
  });
  app.post('/api/ipo/dividend', async (req) => IpoStateSchema.parse(await deps.ipo.dividend(IpoDividendSchema.parse(req.body))));
  app.post('/api/ipo/end-sale', async () => IpoStateSchema.parse(await deps.ipo.endSale()));
}
