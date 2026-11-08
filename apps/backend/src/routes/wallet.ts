/* The OutLayer company wallet (brief 03): read its state, paste its key, or bind it to the CEO's NEAR account.
   No response carries the wallet key; the connect URL (which embeds it) is returned only to the bind call. */
import type { FastifyInstance } from 'fastify';
import { WalletBindReplySchema, WalletBindSchema, WalletKeySchema, WalletStateSchema } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { gameState } from './game.ts';

export function register(app: FastifyInstance, deps: AppServices) {
  app.get('/api/wallet', async () => WalletStateSchema.parse(await deps.wallet.state()));
  app.post('/api/wallet/key', async (req) => {
    await deps.wallet.useKey(WalletKeySchema.parse(req.body).apiKey);
    await deps.pushDepartmentEnv();
    await gameState(deps, true);
    return WalletStateSchema.parse(await deps.wallet.state());
  });
  app.post('/api/wallet/bind', async (req) => {
    const connectUrl = await deps.wallet.bind(WalletBindSchema.parse(req.body).accountId);
    await deps.pushDepartmentEnv();
    return WalletBindReplySchema.parse({ connectUrl });
  });
}
