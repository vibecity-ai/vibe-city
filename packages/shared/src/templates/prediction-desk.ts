import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Research'),
  seat('Forecaster', { toolsets: ['web'] }),
  seat('Position Trader', { skills: ['polymarket-connector'] }),
];

export const predictionDesk = template({
  id: 'prediction-desk', name: 'Prediction Desk', unlock: 'connect-polymarket', loop: true, wallet: 'company', dailyBudgetCredits: 300,
  toolsets: ['web', 'terminal'], skills: ['agent-custody', 'polymarket-connector', 'polymarket', 'coingecko'], seats,
  purpose: purpose('Trades prediction markets for the company with the shared company wallet, inside its OutLayer policy.', seats, [
    'Head of Research picks markets that fit this purpose, sizes the position, and ends its result with [pnl usd=<realized profit or loss>].',
    'Forecaster gathers the evidence and gives a probability estimate for a market.',
    'Position Trader buys, sells and claims outcome shares with polymarket-connector, inside the policy.',
  ]),
});
