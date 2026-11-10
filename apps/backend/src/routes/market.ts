/* The NEAR AI Agent Market (brief 02): list a floor as an agent (the Chief of Staff does it through the MCP tool; this
   route is the same action for scripts) and see the jobs it took. The aat_ token is write-only: no response carries it. */
import type { FastifyInstance } from 'fastify';
import { MarketAdoptionSchema, MarketProfileSchema, MarketRegisterSchema, MarketViewSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  const { market } = deps;
  // one poll right away, so the card shows the verified token and any waiting job without the 45 s wait
  const poll = async () => { await market.tick(); await gameState(deps, true); return MarketViewSchema.parse(market.view()); };
  app.get('/api/market', async () => MarketViewSchema.parse(market.view()));
  app.get('/api/market/:departmentId/profile', async (req) => MarketProfileSchema.parse(await market.profile((req.params as { departmentId: string }).departmentId)));
  // a one-time link that moves the self-registered agent into the boss's market.near.ai account
  app.post('/api/market/:departmentId/adoption', async (req) => MarketAdoptionSchema.parse(await market.adoption((req.params as { departmentId: string }).departmentId)));
  app.post('/api/market/register', async (req) => { await deps.listOnMarket(MarketRegisterSchema.parse(req.body)); return poll(); });
}
