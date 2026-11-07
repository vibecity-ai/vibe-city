/* The OutLayer company wallet (brief 03 fills this in). Until then: not registered. */
import type { FastifyInstance } from 'fastify';
import { WalletStateSchema, type WalletState } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

export const EMPTY_WALLET: WalletState = { registered: false, accountId: null, handoffUrl: null, binding: { accountId: null, status: 'none' }, balances: [], shielded: false, error: null };

export function register(app: FastifyInstance, _deps: AppServices) {
  app.get('/api/wallet', async () => WalletStateSchema.parse(EMPTY_WALLET));
}
