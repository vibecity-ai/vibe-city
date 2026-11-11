import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Treasury Ops'),
  seat('Swap Operator'),
  seat('Reconciler', { toolsets: ['web'] }),
];

/** The first money floor: everything the OutLayer custody wallet does on its own (balances, transfers, swaps and
    cross-chain moves through NEAR Intents), so it opens as soon as the treasury is set up. Perps and prediction markets
    need a connector policy first (Trading Desk, Prediction Desk). */
export const treasuryOps = template({
  id: 'treasury-ops', name: 'Treasury Ops', unlock: 'treasury', loop: false, wallet: 'company', dailyBudgetCredits: 300,
  toolsets: ['web', 'terminal'], skills: ['agent-custody', 'defillama'], seats,
  purpose: purpose('Swaps, moves and rebalances the company\'s funds across tokens and chains through agent-custody\'s NEAR Intents endpoints, from the shared company wallet and inside its OutLayer policy.', seats, [
    'Head of Treasury Ops turns each objective into a plan (what to swap or move, how much, and why), hands it out, and ends its result with [pnl usd=<realized profit or loss>] when a swap closes a position, valued at defillama\'s token prices.',
    'Swap Operator quotes and executes swaps, deposits and withdrawals with agent-custody\'s intents endpoints and its token reference for token ids, inside the policy.',
    'Reconciler reads the wallet and Intents balances before and after every move, confirms it settled, and reports the difference in tokens and in USD (defillama\'s token prices).',
    'After the IPO, when the CEO asks to share revenue, Head of Treasury Ops sends the amount from the company wallet to the company\'s Sputnik DAO (<name>.sputnik-dao.near) with agent-custody\'s ft_transfer, and Reconciler confirms the DAO received it. The CEO pays holders from the DAO, not the agents.',
  ]),
});
