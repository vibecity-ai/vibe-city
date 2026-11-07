import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Trading'),
  seat('Market Analyst', { toolsets: ['web'] }),
  seat('Perps Trader', { skills: ['hyperliquid-connector'] }),
  seat('Risk Officer', { skills: ['agent-custody'] }),
];

export const tradingDesk = template({
  id: 'trading-desk', name: 'Trading Desk', unlock: 'treasury', loop: true, wallet: 'company', dailyBudgetCredits: 500,
  toolsets: ['web', 'terminal'], skills: ['agent-custody', 'hyperliquid-connector'], seats,
  purpose: purpose('Trades perpetual futures for the company with the shared company wallet, inside its OutLayer policy.', seats, [
    'Head of Trading splits each objective into research, execution and review, and ends its result with [pnl usd=<realized profit or loss>].',
    'Market Analyst: prices, funding and news; a one-page brief with a recommended position and size.',
    'Perps Trader: opens, protects and closes positions with hyperliquid-connector, inside the policy.',
    'Risk Officer: reads balances and positions with agent-custody, checks exposure against the limits in this purpose and tells the lead to cut.',
    'The floor shares the company wallet key: this split of duties is kept by these instructions, not enforced by OutLayer.',
  ]),
});
