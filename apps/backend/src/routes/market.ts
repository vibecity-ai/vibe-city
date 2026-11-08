/* The NEAR AI Agent Market (brief 02): register the company as an agent (or paste its token) and see the jobs it took.
   The aat_ token is write-only: no response carries it. */
import type { FastifyInstance } from 'fastify';
import { ListingDraftSchema, MarketRegisterSchema, MarketTokenSchema, MarketViewSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  const { market } = deps;
  // the token goes to the Marketplace Agency's profiles (MARKET_AGENT_TOKEN), and nowhere else
  const poll = async () => { await market.tick(); await gameState(deps, true); return MarketViewSchema.parse(market.view()); };
  const after = async () => { await deps.pushDepartmentEnv(); return poll(); };
  app.get('/api/market', async () => MarketViewSchema.parse(market.view()));
  app.post('/api/market/listing-draft', async () => ListingDraftSchema.parse(await market.draftListing()));
  app.post('/api/market/register', async (req) => { await market.register(MarketRegisterSchema.parse(req.body)); return after(); });
  app.post('/api/market/token', async (req) => { const b = MarketTokenSchema.parse(req.body); await market.useToken(b.handle, b.token); return after(); });
  /** "Check now": one poll of the agent's assignments. */
  app.post('/api/market/poll', async () => poll());
}
