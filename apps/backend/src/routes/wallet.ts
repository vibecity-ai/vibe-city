/* The OutLayer company wallet (brief 03): read its state, paste its key, or bind it to the CEO's NEAR account.
   No response carries the wallet key; the connect URL (which embeds it) is returned only to the bind call. */
import type { FastifyInstance } from 'fastify';
import { ConnectorCheckReplySchema, ConnectorNameSchema, WalletBindReplySchema, WalletBindSchema, WalletKeySchema, WalletStateSchema } from '@vibe-city/shared';
import { readSettings, writeSettings } from './company.ts';
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
  // The connect-hyperliquid / connect-polymarket quests: done once OutLayer reports the owner's policy for the wallet.
  app.post('/api/wallet/connectors/:name/check', async (req) => {
    const name = ConnectorNameSchema.parse((req.params as { name: string }).name);
    const { present, error, callsLeft } = await deps.wallet.connectorPolicy(name);
    if (present) {
      writeSettings(deps.db, { [`${name}ConnectedAt`]: new Date().toISOString() });
      await gameState(deps, true);
    }
    const account = readSettings(deps.db).outlayerAccountId;
    // The connector attaches only the policy row of the wallet's OWNER (the account that holds the wallet's own policy,
    // set at app.outlayer.ai/wallet?key=…). A row stored by an account that does not own the wallet is never applied.
    const message = (present ? `OutLayer applies your ${name} policy to the company wallet.`
      : error ? `The ${name} connector answered: ${error}`
      : `OutLayer applies its built-in default to the company wallet: no ${name} policy reaches it. It uses only the policy of the wallet's owner, so `
        + `store it at app.outlayer.ai/connect/${name} (wallet account ${account}) with the same NEAR account that owns the wallet's own policy `
        + `(app.outlayer.ai/wallet, opened with the wallet key).`)
      + (callsLeft === null ? '' : ` Each check uses one trial call: ${callsLeft} left.`);
    return ConnectorCheckReplySchema.parse({ connected: present, message });
  });
  app.post('/api/wallet/bind', async (req) => {
    const connectUrl = await deps.wallet.bind(WalletBindSchema.parse(req.body).accountId);
    await deps.pushDepartmentEnv();
    return WalletBindReplySchema.parse({ connectUrl });
  });
}
