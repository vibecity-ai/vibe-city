/* The game loop: CEO quests, decisions, runway (brief 05 fills this in). */
import type { FastifyInstance } from 'fastify';
import { GameStateSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

export function register(app: FastifyInstance, _deps: AppServices) {
  app.get('/api/game', async () => GameStateSchema.parse({
    quests: [], decisions: [], runway: { creditsRemainingCents: null, dailyBurnCents: 0, days: null, earnedCents: 0, estimated: true }, ipoUnlocked: false,
  }));
}
