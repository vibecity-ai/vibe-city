import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Treasury Ops'),
  seat('Swap Operator', { skills: ['near-intents'] }),
  seat('Reconciler', { toolsets: ['web'] }),
];

/** The first money floor: everything the OutLayer custody wallet does on its own (balances, transfers, swaps and
    cross-chain moves through NEAR Intents), so it opens as soon as the treasury is funded. Perps and prediction markets
    need a connector policy first (Trading Desk, Prediction Desk). */
export const treasuryOps = template({
  id: 'treasury-ops', name: 'Treasury Ops', unlock: 'treasury', loop: false, wallet: 'company', dailyBudgetCredits: 300,
  toolsets: ['web', 'terminal'], skills: ['agent-custody', 'near-intents', 'coingecko', 'defillama'], seats,
  purpose: purpose('Swaps, moves and rebalances the company\'s funds across tokens and chains through NEAR Intents, from the shared company wallet and inside its OutLayer policy.', seats, [
    'Head of Treasury Ops turns each objective into a plan (what to swap or move, how much, and why), hands it out, and ends its result with [pnl usd=<realized profit or loss>] when a swap closes a position.',
    'Swap Operator quotes and executes swaps, deposits and withdrawals with agent-custody\'s intents endpoints, using near-intents for token ids and routes, inside the policy.',
    'Reconciler reads the wallet and Intents balances before and after every move, confirms it settled, and reports the difference.',
    'The IPO: when the CEO asks for it, Head of Treasury Ops creates the company\'s Sputnik DAO vault with agent-custody\'s contract call from the company wallet (method create on sputnik-dao.near, the CEO\'s NEAR account and the company wallet on the council), checks it with get_policy, and ends its result with [dao account=<name>.sputnik-dao.near].',
  ]),
});
